import { describe, expect, it } from "vitest";
import { type GamePlayerRecord, type GameRecord, GameSettings } from "@cabal/protocol";
import {
  GLICKO,
  NEWCOMER,
  type Participant,
  type Rating,
  RATING_RULES,
  conservative,
  countsForLedger,
  decayed,
  established,
  glicko2,
  pairWeight,
  pairings,
  rateGame,
  ratedGame,
  reliability,
  trust,
} from "../src/ratings.js";

const stint = (power: GamePlayerRecord["power"], playerId: string | null, over: Partial<GamePlayerRecord> = {}): GamePlayerRecord => ({
  power,
  stint: 0,
  kind: playerId ? "human" : "ai",
  playerId,
  name: playerId,
  joinedAt: 0,
  substitute: false,
  leftReason: null,
  civilDisorder: false,
  phasesDue: 10,
  phasesOnTime: 10,
  phasesLate: 0,
  ledger: { kept: 0, broken: 0, void: 0 },
  ...over,
});

const record = (over: Partial<GameRecord> = {}): GameRecord => ({
  gameId: "RATED1",
  result: "solo",
  reason: "solo",
  winners: ["FRANCE"],
  scores: { AUSTRIA: 0, ENGLAND: 0, FRANCE: 1, GERMANY: 0, ITALY: 0, RUSSIA: 0, TURKEY: 0 },
  settings: GameSettings.parse({ visibility: "public" }),
  cluster: "standard:full:async",
  phaseCount: 20,
  movementPhases: 8,
  createdAt: 0,
  finishedAt: 1,
  ledger: {},
  seats: [],
  players: [stint("FRANCE", "pa"), stint("ENGLAND", "pb"), stint("GERMANY", "pc"), stint("ITALY", null)],
  ...over,
});

describe("Glicko-2", () => {
  it("reproduces Glickman's worked example with every weight 1", () => {
    const out = glicko2({ rating: 1500, rd: 200, volatility: 0.06 }, [
      { rating: 1400, rd: 30, score: 1, weight: 1 },
      { rating: 1550, rd: 100, score: 0, weight: 1 },
      { rating: 1700, rd: 300, score: 0, weight: 1 },
    ]);
    expect(out.rating).toBeCloseTo(1464.06, 1);
    expect(out.rd).toBeCloseTo(151.52, 1);
    expect(out.volatility).toBeCloseTo(0.05999, 4);
    // The per-opponent breakdown adds up to the change exactly.
    const sum = out.contributions.reduce((a, c) => a + c.delta, 0);
    expect(sum).toBeCloseTo(out.rating - 1500, 9);
  });

  it("moves a rating less, and shrinks its deviation less, when results are down-weighted", () => {
    const full = glicko2(NEWCOMER, [{ rating: 1500, rd: 350, score: 1, weight: 1 }]);
    const third = glicko2(NEWCOMER, [{ rating: 1500, rd: 350, score: 1, weight: 1 / 3 }]);
    expect(third.rating - 1500).toBeGreaterThan(0);
    expect(third.rating - 1500).toBeLessThan(full.rating - 1500);
    expect(third.rd).toBeGreaterThan(full.rd);
  });

  it("only grows the deviation over a period with no games, never past a newcomer's", () => {
    const idle = glicko2({ rating: 1700, rd: 80, volatility: 0.06 }, []);
    expect(idle.rating).toBe(1700);
    expect(idle.rd).toBeGreaterThan(80);
    expect(decayed({ rating: 1700, rd: 80, volatility: 0.06 }, 0, 0).rd).toBe(80);
    expect(decayed({ rating: 1700, rd: 80, volatility: 0.06 }, 0, 12 * GLICKO.periodMs).rd).toBeGreaterThan(idle.rd);
    expect(decayed({ rating: 1700, rd: 300, volatility: 0.06 }, 0, 10_000 * GLICKO.periodMs).rd).toBe(GLICKO.maxRd);
  });
});

describe("pairings", () => {
  const table = (scores: number[]): Participant[] => scores.map((score, i) => ({ playerId: `p${i}`, power: `P${i}`, score, substitute: false }));

  it("weights a full table like two head-to-head games, never more than one each", () => {
    expect(pairWeight(7)).toBeCloseTo(1 / 3);
    expect(pairWeight(3)).toBe(1);
    expect(pairWeight(2)).toBe(1);
    expect(pairWeight(1)).toBe(0);
  });

  it("has a solo winner beat everyone and leaves the losers unpaired with each other", () => {
    const players = table([1, 0, 0, 0]);
    expect(pairings(players, 0)).toEqual([
      { opponent: 1, score: 1 },
      { opponent: 2, score: 1 },
      { opponent: 3, score: 1 },
    ]);
    expect(pairings(players, 1)).toEqual([{ opponent: 0, score: 0 }]);
  });

  it("scores Sum of Squares draw members by their shares, and draws evenly under Draw Size", () => {
    // 12 and 6 centres: shares 0.8 and 0.2 of a two-way SoS draw.
    const sos = table([0.8, 0.2, 0]);
    expect(pairings(sos, 0)[0]!.score).toBeCloseTo(0.8);
    expect(pairings(sos, 1)).toEqual([
      { opponent: 0, score: expect.closeTo(0.2) },
      { opponent: 2, score: 1 },
    ]);
    expect(pairings(table([0.5, 0.5]), 0)).toEqual([{ opponent: 1, score: 0.5 }]);
  });

  it("leaves a symmetric draw where it found it, and moves a solo's winner up and its losers down", () => {
    const draw = rateGame(table([1 / 3, 1 / 3, 1 / 3]), new Map());
    for (const change of draw) {
      expect(change.after.rating).toBeCloseTo(1500, 6);
      expect(change.after.rd).toBeLessThan(350);
    }
    const solo = rateGame(table([1, 0, 0, 0, 0, 0, 0]), new Map());
    expect(solo[0]!.after.rating).toBeGreaterThan(1500);
    for (const loser of solo.slice(1)) expect(loser.after.rating).toBeLessThan(1500);
    // Each change is the sum of its per-opponent parts.
    for (const change of solo) {
      expect(change.opponents.reduce((a, o) => a + o.delta, 0)).toBeCloseTo(change.after.rating - change.before.rating, 6);
    }
  });

  it("never lets a substitute lose rating", () => {
    const players = table([1, 0, 0]);
    players[2]!.substitute = true;
    const changes = rateGame(players, new Map());
    expect(changes[1]!.after.rating).toBeLessThan(1500);
    expect(changes[2]!.after.rating).toBe(1500);
    expect(changes[2]!.after.rd).toBeLessThan(350);
  });

  it("takes several full tables for a newcomer to become established", () => {
    let me = { ...NEWCOMER, games: 0 };
    let games = 0;
    while (!established(me) && games < 50) {
      const [change] = rateGame(
        [
          { playerId: "me", power: "FRANCE", score: 0.4, substitute: false },
          ...[1, 2, 3, 4, 5, 6].map((i) => ({ playerId: `o${i}`, power: `P${i}`, score: 0.1, substitute: false })),
        ],
        new Map<string, Rating>([["me", me], ...[1, 2, 3, 4, 5, 6].map((i) => [`o${i}`, { rating: 1500, rd: 120, volatility: 0.06 }] as [string, Rating])]),
      );
      me = { ...change!.after, games: ++games };
    }
    expect(games).toBeGreaterThanOrEqual(RATING_RULES.establishedGames);
    expect(games).toBeLessThanOrEqual(8);
    expect(conservative(me)).toBeGreaterThan(conservative(NEWCOMER));
  });
});

describe("rated games", () => {
  it("rates a public, decided, two-year game with three signed-in players, and nobody else", () => {
    const rated = ratedGame(record());
    expect(rated).toMatchObject({ rated: true, reason: null });
    expect(rated.participants.map((p) => [p.playerId, p.score])).toEqual([
      ["pa", 1],
      ["pb", 0],
      ["pc", 0],
    ]);
  });

  it("explains why a game is not rated", () => {
    expect(ratedGame(record({ settings: GameSettings.parse({}) })).reason).toBe("not_public");
    expect(ratedGame(record({ result: "abandoned", winners: [], scores: {} })).reason).toBe("not_decided");
    expect(ratedGame(record({ movementPhases: 3 })).reason).toBe("too_short");
    expect(ratedGame(record({ movementPhases: undefined })).reason).toBe("too_short");
    expect(ratedGame(record({ players: [stint("FRANCE", "pa"), stint("ENGLAND", "pb")] })).reason).toBe("too_few_players");
    // A record from before players existed has nobody to rate.
    expect(ratedGame(record({ players: undefined })).reason).toBe("too_few_players");
  });

  it("gives a player who left their seat a loss and the substitute the seat's result", () => {
    const rated = ratedGame(
      record({
        players: [
          stint("FRANCE", "pa", { leftReason: "replaced" }),
          stint("FRANCE", "pd", { stint: 1, substitute: true }),
          stint("ENGLAND", "pb"),
          stint("GERMANY", "pc"),
        ],
      }),
    );
    expect(rated.rated).toBe(true);
    expect(rated.participants.map((p) => [p.playerId, p.score, p.substitute])).toEqual([
      ["pa", 0, false],
      ["pd", 1, true],
      ["pb", 0, false],
      ["pc", 0, false],
    ]);
  });
});

describe("reliability and trust", () => {
  it("start a newcomer at 90 and 50 percent and move with the record", () => {
    expect(reliability({ phasesDue: 0, phasesOnTime: 0, phasesLate: 0, gamesWalkedOut: 0 })).toBeCloseTo(0.9);
    expect(reliability({ phasesDue: 40, phasesOnTime: 40, phasesLate: 0, gamesWalkedOut: 0 })).toBeCloseTo(49 / 50);
    expect(reliability({ phasesDue: 40, phasesOnTime: 30, phasesLate: 10, gamesWalkedOut: 0 })).toBeCloseTo(44 / 50);
    expect(reliability({ phasesDue: 10, phasesOnTime: 2, phasesLate: 0, gamesWalkedOut: 1 })).toBeCloseTo(11 / 24);
    expect(trust({ kept: 0, broken: 0 })).toBe(0.5);
    expect(trust({ kept: 20, broken: 0 })).toBeCloseTo(25 / 30);
    expect(trust({ kept: 0, broken: 10 })).toBeCloseTo(0.25);
  });

  it("counts a pledge only when it was made to another person", () => {
    expect(countsForLedger({ pledgerPlayer: "pa", audience: "ENGLAND", audiencePlayer: "pb" }, 2)).toBe(true);
    expect(countsForLedger({ pledgerPlayer: "pa", audience: "ENGLAND", audiencePlayer: null }, 2)).toBe(false);
    expect(countsForLedger({ pledgerPlayer: "pa", audience: "FRANCE", audiencePlayer: "pa" }, 2)).toBe(false);
    expect(countsForLedger({ pledgerPlayer: null, audience: "ENGLAND", audiencePlayer: "pb" }, 2)).toBe(false);
    expect(countsForLedger({ pledgerPlayer: "pa", audience: "ALL", audiencePlayer: null }, 2)).toBe(true);
    expect(countsForLedger({ pledgerPlayer: "pa", audience: "ALL", audiencePlayer: null }, 1)).toBe(false);
  });
});

/** Ratings, reliability and the trust ledger, folded from finished games into D1 and read back. */
import { describe, expect, it } from "vitest";
import { type GamePlayerRecord, type GameRecord, GameSettings, LeaderboardResponse, PlayerProfile, TrustLeaderboardResponse } from "@cabal/protocol";
import { Game } from "@cabal/engine";
import { RATING_RULES } from "../src/ratings.js";
import { Client, call, createAs, index, inRoom, joinAs, newPlayer, serverEnv, sleep, start, untilIndexed } from "./helpers.js";


const db = () => serverEnv.DB!;
let games = 0;
const code = () => `ST${(++games).toString(36).toUpperCase().padStart(4, "0")}`;

const POWERS = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"] as const;

/** A finished public game: `table[i]` holds POWERS[i] with share `scores[i]`; the rest are AI seats. */
function finished(table: { playerId: string | null; score: number; over?: Partial<GamePlayerRecord> }[], over: Partial<GameRecord> = {}): GameRecord {
  const scores = Object.fromEntries(POWERS.map((p, i) => [p, table[i]?.score ?? 0]));
  const players: GamePlayerRecord[] = POWERS.map((power, i) => ({
    power,
    stint: 0,
    kind: table[i]?.playerId ? "human" : "ai",
    playerId: table[i]?.playerId ?? null,
    name: table[i]?.playerId ?? "Automaton",
    joinedAt: 1,
    substitute: false,
    leftReason: null,
    civilDisorder: false,
    phasesDue: table[i]?.playerId ? 8 : 0,
    phasesOnTime: table[i]?.playerId ? 8 : 0,
    phasesLate: 0,
    ledger: { kept: 0, broken: 0, void: 0 },
    ...table[i]?.over,
  }));
  const winners = POWERS.filter((p) => scores[p]! > 0);
  return {
    gameId: code(),
    result: winners.length === 1 ? "solo" : "draw",
    reason: winners.length === 1 ? "solo" : "vote",
    winners,
    scores,
    settings: GameSettings.parse({ visibility: "public" }),
    cluster: "standard:full:async",
    phaseCount: 12,
    movementPhases: 8,
    createdAt: 1,
    finishedAt: Date.now(),
    ledger: {},
    seats: POWERS.map((power) => ({ power, kind: "human", name: null, centers: scores[power]! > 0 ? 9 : 2, eliminated: false })),
    players,
    ...over,
  };
}

const rating = async (playerId: string) => db().prepare("SELECT * FROM ratings WHERE player_id = ?").bind(playerId).first<{ rating: number; rd: number; games: number }>();

describe("rating finished games", () => {
  it("rates a public game once, however often it is recorded, with a per-opponent breakdown", async () => {
    const [a, b, c] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    const game = finished([
      { playerId: a.player.id, score: 1 },
      { playerId: b.player.id, score: 0 },
      { playerId: c.player.id, score: 0 },
    ]);
    await index().recordGame(game);
    await index().recordGame(game);
    const ra = (await rating(a.player.id))!;
    expect(ra.games).toBe(1);
    expect(ra.rating).toBeGreaterThan(1500);
    expect((await rating(b.player.id))!.rating).toBeLessThan(1500);
    const history = (await db().prepare("SELECT * FROM rating_history WHERE game_id = ?").bind(game.gameId).all<{ player_id: string; opponents_json: string; rating_after: number; rating_before: number }>()).results;
    expect(history).toHaveLength(3);
    const winner = history.find((h) => h.player_id === a.player.id)!;
    const parts = JSON.parse(winner.opponents_json) as { playerId: string; delta: number }[];
    expect(parts.map((p) => p.playerId).sort()).toEqual([b.player.id, c.player.id].sort());
    expect(parts.reduce((s, p) => s + p.delta, 0)).toBeCloseTo(winner.rating_after - winner.rating_before, 6);
    const profile = PlayerProfile.parse(await (await call(`/api/players/${a.player.handle}`, null)).json());
    expect(profile.rating).toMatchObject({ games: 1, established: false, rank: null });
    expect(profile.recent[0]).toMatchObject({ gameId: game.gameId, result: "solo", score: 1 });
    expect(profile.recent[0]!.ratingDelta).toBeCloseTo(ra.rating - 1500, 6);
    expect(profile.games).toMatchObject({ played: 1, solos: 1, draws: 0 });
  });

  it("leaves unlisted, short, abandoned and small games unrated, but on the record", async () => {
    const [a, b, c] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    const table = [
      { playerId: a.player.id, score: 1 },
      { playerId: b.player.id, score: 0 },
      { playerId: c.player.id, score: 0 },
    ];
    await index().recordGame(finished(table, { settings: GameSettings.parse({}) }));
    await index().recordGame(finished(table, { movementPhases: RATING_RULES.minMovementPhases - 1 }));
    await index().recordGame(finished(table, { result: "abandoned", reason: "no_orders", winners: [], scores: {} }));
    await index().recordGame(finished(table.slice(0, 2)));
    expect(await rating(a.player.id)).toBeNull();
    const profile = PlayerProfile.parse(await (await call(`/api/players/${a.player.handle}`, null)).json());
    expect(profile.games.played).toBe(4);
    expect(profile.reliability.phasesDue).toBe(32);
  });

  it("loses no update when two games with the same players end at once", async () => {
    const [a, b, c] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    const one = finished([
      { playerId: a.player.id, score: 0.5 },
      { playerId: b.player.id, score: 0.5 },
      { playerId: c.player.id, score: 0 },
    ]);
    const two = finished([
      { playerId: c.player.id, score: 1 },
      { playerId: b.player.id, score: 0 },
      { playerId: a.player.id, score: 0 },
    ]);
    await Promise.all([index().recordGame(one), index().recordGame(two)]);
    for (const p of [a, b, c]) expect((await rating(p.player.id))!.games).toBe(2);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM rated_games WHERE game_id IN (?, ?)").bind(one.gameId, two.gameId).first<{ n: number }>())!.n).toBe(2);
  });

  it("gives a player who left a loss and spares the substitute who took a losing seat", async () => {
    const [quitter, sub, b, c] = await Promise.all([newPlayer(), newPlayer(), newPlayer(), newPlayer()]);
    const game = finished([
      { playerId: quitter.player.id, score: 0, over: { leftReason: "replaced", phasesDue: 3, phasesOnTime: 1 } },
      { playerId: b.player.id, score: 1 },
      { playerId: c.player.id, score: 0 },
    ]);
    game.players!.push({ ...game.players![0]!, stint: 1, playerId: sub.player.id, substitute: true, leftReason: null, phasesDue: 5, phasesOnTime: 5 });
    await index().recordGame(game);
    expect((await rating(quitter.player.id))!.rating).toBeLessThan(1500);
    expect((await rating(sub.player.id))!.rating).toBe(1500);
    const profile = PlayerProfile.parse(await (await call(`/api/players/${quitter.player.handle}`, null)).json());
    expect(profile.reliability).toMatchObject({ phasesDue: 3, phasesOnTime: 1, missed: 2, gamesWalkedOut: 1, gamesCompleted: 0 });
    expect(profile.reliability.score).toBeLessThan(0.9);
    expect(profile.recent[0]).toMatchObject({ walkedOut: true, score: 0 });
  });

  it("puts established players on the leaderboard in order, with ranks that match their profiles", async () => {
    const [a, b, c] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    // Enough games for everyone to be established; a wins most.
    for (let i = 0; i < 8; i++) {
      await index().recordGame(
        finished([
          { playerId: a.player.id, score: i % 4 === 3 ? 0 : 1 },
          { playerId: b.player.id, score: i % 4 === 3 ? 1 : 0 },
          { playerId: c.player.id, score: 0 },
        ]),
      );
    }
    const board = LeaderboardResponse.parse(await (await call("/api/leaderboard?limit=100", null)).json());
    const mine = board.entries.filter((e) => [a, b, c].some((p) => p.player.id === e.player.id));
    expect(mine.map((e) => e.player.id)).toEqual([a.player.id, b.player.id, c.player.id]);
    for (let i = 1; i < board.entries.length; i++) expect(board.entries[i - 1]!.conservative).toBeGreaterThanOrEqual(board.entries[i]!.conservative);
    const top = PlayerProfile.parse(await (await call(`/api/players/${a.player.handle}`, null)).json());
    expect(top.rating).toMatchObject({ established: true, rank: mine[0]!.rank, games: 8 });
    // Paging: one entry a page, and the next page starts after it.
    const first = LeaderboardResponse.parse(await (await call("/api/leaderboard?limit=1", null)).json());
    expect(first.entries).toHaveLength(1);
    expect(first.next).toBe(1);
    const second = LeaderboardResponse.parse(await (await call("/api/leaderboard?limit=1&offset=1", null)).json());
    expect(second.entries[0]!.rank).toBe(2);
    expect((await call("/api/leaderboard", null)).headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("keeps the trust ledger: kept, broken and void across games, most trustworthy first", async () => {
    const [honest, liar, other] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    const pledges = (kept: number, broken: number) => ({ ledger: { kept, broken, void: 1 } });
    await index().recordGame(
      finished(
        [
          { playerId: honest.player.id, score: 0.5, over: pledges(6, 0) },
          { playerId: liar.player.id, score: 0.5, over: pledges(1, 5) },
          { playerId: other.player.id, score: 0 },
        ],
      ),
    );
    await index().recordGame(finished([{ playerId: honest.player.id, score: 1, over: pledges(2, 1) }, { playerId: liar.player.id, score: 0 }, { playerId: other.player.id, score: 0 }]));
    const board = TrustLeaderboardResponse.parse(await (await call("/api/ledger?limit=100", null)).json());
    const h = board.entries.find((e) => e.player.id === honest.player.id)!;
    const l = board.entries.find((e) => e.player.id === liar.player.id)!;
    expect(h.trust).toMatchObject({ kept: 8, broken: 1, void: 2 });
    expect(h.trust.score).toBeCloseTo((8 + 5) / (9 + 10));
    expect(l.trust).toMatchObject({ kept: 1, broken: 5 });
    expect(h.rank).toBeLessThan(l.rank);
    // Too few pledges to be ranked.
    expect(board.entries.some((e) => e.player.id === other.player.id)).toBe(false);
  });

  it("keeps pledges from games below the rated bar out of the trust ledger", async () => {
    const [a, b, c] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    const many = { over: { ledger: { kept: 60, broken: 0, void: 0 } } };
    const table = [
      { playerId: a.player.id, score: 0.5, ...many },
      { playerId: b.player.id, score: 0.5, ...many },
      { playerId: c.player.id, score: 0, ...many },
    ];
    // Unlisted, abandoned, one phase long, and two signed-in players: none of them count.
    await index().recordGame(finished(table, { settings: GameSettings.parse({}) }));
    await index().recordGame(finished(table, { result: "abandoned", reason: "inactive", winners: [], scores: {} }));
    await index().recordGame(finished(table, { movementPhases: 1, phaseCount: 1 }));
    await index().recordGame(finished(table.slice(0, 2)));
    for (const p of [a, b, c]) {
      const profile = PlayerProfile.parse(await (await call(`/api/players/${p.player.handle}`, null)).json());
      expect(profile.trust, p.player.handle).toMatchObject({ kept: 0, broken: 0, void: 0 });
    }
    // The same table in a game that meets the bar counts.
    await index().recordGame(finished(table));
    const profile = PlayerProfile.parse(await (await call(`/api/players/${a.player.handle}`, null)).json());
    expect(profile.trust).toMatchObject({ kept: 60, broken: 0 });
  });

  it("does not let two accounts farm the ledger with self-kept pledges in an unlisted game", async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    const ann = await createAs(a.secret, { aiFill: true }); // unlisted, the default
    const bobRes = await joinAs(b.secret, ann.gameId, {});
    expect(bobRes.status).toBe(200);
    const bob = (await bobRes.json()) as { token: string; power: string };
    expect((await start({ gameId: ann.gameId, token: ann.token, power: ann.power })).status).toBe(200);
    // One unit each and nobody else on the board, so every hold is trivially kept.
    const state = new Game().state();
    state.units = { [ann.power]: ["A PAR"], [bob.power]: ["A MUN"] };
    await inRoom(ann.gameId, async (room, storage) => {
      const game = Game.fromState(state);
      (room as unknown as { game: Game }).game = game;
      await storage.storage.put("saved", game.toSaved(ann.gameId));
    });
    const ca = await Client.connect(ann.gameId, ann.token);
    const cb = await Client.connect(ann.gameId, bob.token);
    await ca.next("welcome");
    await cb.next("welcome");
    for (let i = 0; i < 12; i++) {
      ca.send({ t: "press.send", id: `a${i}`, p: { to: bob.power, body: `promise ${i}`, pledge: { orders: ["A PAR H"] } } });
      cb.send({ t: "press.send", id: `b${i}`, p: { to: ann.power, body: `promise ${i}`, pledge: { orders: ["A MUN H"] } } });
      await ca.next("press", (m) => m.id === `a${i}`);
      await cb.next("press", (m) => m.id === `b${i}`);
      await sleep(110); // under the socket's token bucket
    }
    ca.send({ t: "orders.set", p: { phase: "S1901M", orders: ["A PAR H"] } });
    cb.send({ t: "orders.set", p: { phase: "S1901M", orders: ["A MUN H"] } });
    await ca.next("orders.ack");
    await cb.next("orders.ack");
    ca.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    cb.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await ca.next("state", (m) => m.p.phase !== "S1901M");
    // Twelve kept promises to one power in one phase are one receipt for the player...
    const players = await inRoom(ann.gameId, (room) => (room as unknown as { playersRecord(): GamePlayerRecord[] }).playersRecord());
    expect(players.find((p) => p.playerId === a.player.id)!.ledger).toEqual({ kept: 1, broken: 0, void: 0 });
    // ...and the game, agreed to a draw after one phase of an unlisted table, counts for nothing.
    ca.send({ t: "vote", p: { kind: "draw", value: true } });
    cb.send({ t: "vote", p: { kind: "draw", value: true } });
    const record = await untilIndexed(ann.gameId);
    expect(record.settings.visibility).toBe("unlisted");
    const board = TrustLeaderboardResponse.parse(await (await call("/api/ledger?limit=100", null)).json());
    expect(board.entries.some((e) => e.player.id === a.player.id)).toBe(false);
    const profile = PlayerProfile.parse(await (await call(`/api/players/${a.player.handle}`, null)).json());
    expect(profile.trust).toMatchObject({ kept: 0, broken: 0, void: 0 });
    ca.close();
    cb.close();
  }, 60_000);

  it("answers a page, never a 500, for an offset D1 cannot bind", async () => {
    for (const q of ["offset=Infinity", "offset=1e300", "offset=-5", "offset=NaN", "offset=2.5", "offset=99999999999"]) {
      for (const path of ["/api/leaderboard", "/api/ledger"]) {
        const res = await call(`${path}?${q}`, null);
        expect(res.status, `${path}?${q}`).toBe(200);
        const body = (await res.json()) as { offset: number };
        expect(body.offset, `${path}?${q}`).toBeGreaterThanOrEqual(0);
        expect(body.offset, `${path}?${q}`).toBeLessThanOrEqual(10_000);
      }
    }
  });
});

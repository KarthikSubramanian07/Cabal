import type { PlayerResult, RatingHistoryResponse } from "@cabal/protocol";
import { describe, expect, it } from "vitest";
import { friendlyGames, ratingPath, ratingRange, ratingTicks, reliabilityLine, resultWord, signed, tableState, trustLine, withOwnCodes } from "./record.js";

const game = (delta: number | null, at: number): PlayerResult => ({
  gameId: `G${at}`,
  power: "FRANCE",
  result: "draw",
  score: 0.5,
  centers: 6,
  substitute: false,
  walkedOut: false,
  ratingDelta: delta,
  finishedAt: at,
});

const point = (gameId: string, before: number, after: number, rdBefore: number, rdAfter: number, at: number): RatingHistoryResponse["points"][number] => ({
  gameId,
  power: "FRANCE",
  result: "draw",
  score: 0.5,
  ratingBefore: before,
  rdBefore,
  ratingAfter: after,
  rdAfter,
  at,
});

describe("ratingPath", () => {
  it("draws the history the server stored, oldest first, from where the first game began", () => {
    // The deviation grows between games and the figures need not chain exactly; the path shows
    // what was stored, not what a sum of the recent changes would suggest.
    const path = ratingPath({ points: [point("A", 1500, 1560, 350, 280, 1), point("B", 1560, 1541, 290, 240, 2), point("C", 1541, 1575, 240, 205, 3)] });
    expect(path.map((p) => p.rating)).toEqual([1500, 1560, 1541, 1575]);
    expect(path.map((p) => p.rd)).toEqual([350, 280, 240, 205]);
    expect(path[0]).toMatchObject({ delta: null, game: null });
    expect(path[2]).toMatchObject({ delta: -19, game: { gameId: "B", power: "FRANCE", finishedAt: 2 } });
  });

  it("starts at the real rating before the oldest game listed, even when older games are left out", () => {
    // Only the last two of many games: the path starts at 1612, not at 1500.
    const path = ratingPath({ points: [point("Y", 1612, 1630, 90, 88, 9), point("Z", 1630, 1618, 88, 86, 10)] });
    expect(path[0]!.rating).toBe(1612);
    expect(path.at(-1)!.rating).toBe(1618);
  });

  it("is empty before the first rated game, or when the history did not load", () => {
    expect(ratingPath({ points: [] })).toEqual([]);
    expect(ratingPath(null)).toEqual([]);
  });

  it("gives the likely range as two deviations either side", () => {
    expect(ratingRange({ rating: 1575.4, rd: 60.2 })).toEqual([1455, 1696]);
  });
});

describe("ratingTicks", () => {
  it("covers the values with three or four round ticks", () => {
    const ticks = ratingTicks([1500, 1525, 1510, 1530]);
    expect(ticks[0]).toBeLessThanOrEqual(1500);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(1530);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect(ratingTicks([1500])).toEqual([1490, 1500, 1510]);
  });
});

describe("words", () => {
  it("say a rating change with its sign", () => {
    expect(signed(12.4)).toBe("+12");
    expect(signed(-3.6)).toBe("−4");
    expect(signed(0.2)).toBe("0");
  });

  it("say reliability and trust in a sentence", () => {
    expect(reliabilityLine({ score: 0.9, phasesDue: 0, phasesOnTime: 0, phasesLate: 0, missed: 0, gamesCompleted: 0, gamesWalkedOut: 0 })).toMatch(/90%/);
    expect(reliabilityLine({ score: 0.8, phasesDue: 20, phasesOnTime: 17, phasesLate: 2, missed: 1, gamesCompleted: 2, gamesWalkedOut: 1 })).toBe(
      "Ordered on time in 17 of 20 phases, late in 2, missed 1. Finished 2 of 3 games.",
    );
    expect(trustLine({ score: 0.5, kept: 0, broken: 0, void: 0 })).toMatch(/50%/);
    expect(trustLine({ score: 0.6, kept: 4, broken: 1, void: 2 })).toBe("Kept 4 of 5 promises; 2 came to nothing.");
  });

  it("name a result from the player's share of it", () => {
    expect(resultWord({ result: "solo", score: 1, walkedOut: false })).toBe("Won");
    expect(resultWord({ result: "solo", score: 0, walkedOut: false })).toBe("Lost");
    expect(resultWord({ result: "draw", score: 0.25, walkedOut: false })).toBe("Drew");
    expect(resultWord({ result: "draw", score: 0.25, walkedOut: true })).toBe("Left");
  });
});

describe("withOwnCodes", () => {
  it("gives the owner their unlisted games' codes, matched by seat and when it ended", () => {
    const hidden = { ...game(null, 7), gameId: null };
    const listed = game(null, 8);
    const mine = [
      { gameId: "SECRT2", power: "FRANCE" as const, status: "finished" as const, joinedAt: 1, finishedAt: 7, result: "draw" as const, score: 0.5, centers: 6, ratingDelta: null },
      { gameId: "OTHER3", power: "ITALY" as const, status: "finished" as const, joinedAt: 1, finishedAt: 7, result: "draw" as const, score: 0.5, centers: 6, ratingDelta: null },
    ];
    expect(withOwnCodes([hidden, listed], mine).map((g) => g.gameId)).toEqual(["SECRT2", "G8"]);
    expect(withOwnCodes([hidden], []).map((g) => g.gameId)).toEqual([null]);
  });
});

describe("tableState", () => {
  it("names a game drawn before any phase resolved for what it was, not as abandoned", () => {
    expect(tableState({ status: "abandoned", result: "draw", score: 0 })).toBe("Drawn before play");
    expect(tableState({ status: "abandoned", result: "abandoned", score: 0 })).toBe("Abandoned");
    expect(tableState({ status: "finished", result: "draw", score: 0.5 })).toBe("Drawn");
    expect(tableState({ status: "finished", result: "solo", score: 1 })).toBe("Won");
    expect(tableState({ status: "finished", result: "solo", score: 0 })).toBe("Lost");
    expect(tableState({ status: "playing", result: null, score: null })).toBe("In play");
  });
});

describe("friendlyGames", () => {
  it("counts finished games the public list leaves out, while the list is short enough to know", () => {
    expect(friendlyGames(1, 0)).toBe(1);
    expect(friendlyGames(5, 3)).toBe(2);
    expect(friendlyGames(3, 3)).toBe(0);
    expect(friendlyGames(40, 20)).toBe(0);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { adjudicateStrict, restoreGame } from "../src/adjudicate-guard.js";
import { Game, engineReady } from "../src/engine.js";
import { LEGACY_STANDOFF_RECORD } from "./legacy-record.js";

beforeAll(() => engineReady());

describe("adjudicateStrict", () => {
  it("rethrows and never calls process when normalisation fails", () => {
    const reported: unknown[] = [];
    let processed = false;
    const game = {
      normaliseOrders: (_input: { orders: string[] }): { orders: string[] } => {
        throw new Error("engine broke");
      },
      process: (_input: { orders: string[] }): string => {
        processed = true;
        return "ok";
      },
    };
    expect(() => adjudicateStrict(game, { orders: [] }, (e) => reported.push(e))).toThrow("engine broke");
    expect(processed).toBe(false);
    expect(reported).toHaveLength(1);
  });

  it("returns the outcome when the engine succeeds", () => {
    const game = {
      normaliseOrders: (input: { orders: string[] }) => input,
      process: (input: { orders: string[] }) => `processed ${input.orders.length}`,
    };
    expect(adjudicateStrict(game, { orders: ["a", "b"] }, () => {})).toBe("processed 2");
  });

  it("reports and rethrows a process failure instead of returning a fallback outcome", () => {
    const failure = new Error("adjudication failed");
    const reported: unknown[] = [];
    const game = {
      normaliseOrders: (input: { orders: string[] }) => input,
      process: (_input: { orders: string[] }): string => {
        throw failure;
      },
    };

    expect(() => adjudicateStrict(game, { orders: [] }, (error) => reported.push(error))).toThrow(failure);
    expect(reported).toEqual([failure]);
  });
});

describe("restoreGame", () => {
  // What the room does around a write: take the record, let the engine advance, and when storage
  // throws put the engine back from that record. Run here on a game whose history today's engine
  // would rule differently, which is the case that used to throw inside the catch block.
  it("puts a game back after a failed write even when its history no longer replays", () => {
    expect(() => Game.fromSaved(LEGACY_STANDOFF_RECORD, "2023")).toThrow(/replay diverged from the recorded state after S1902R/);

    const game = Game.resume(LEGACY_STANDOFF_RECORD, "2023"); // the wake
    expect(game.phase()).toBe("F1902M");
    const snapshot = game.toSaved("LEGACY");
    game.process({ orders: {} }); // the engine advanced, then storage threw
    expect(game.phase()).not.toBe("F1902M");

    const restored = restoreGame(Game, snapshot, "2023");
    expect(restored.phase()).toBe("F1902M");
    expect(restored.state()).toEqual(Game.resume(LEGACY_STANDOFF_RECORD, "2023").state());
    expect(restored.state().units["GERMANY"]).toEqual(["A TYR"]); // the old ruling stands as recorded
    expect(restored.historyLength()).toBe(2);
    expect(restored.toSaved("LEGACY")).toBe(snapshot);

    // and the game goes on from there
    restored.process({ orders: { GERMANY: ["A TYR - MUN"] } });
    expect(restored.historyLength()).toBe(3);
    game.free();
    restored.free();
  });

  it("puts back a game that was told it is drawn before the vote could be stored", () => {
    const game = new Game();
    game.process({ orders: { FRANCE: ["A PAR - BUR"] } });
    const snapshot = game.toSaved("VOTE");
    game.declareDraw();
    expect(game.status()).not.toBe("active");
    const restored = restoreGame(Game, snapshot, "2023");
    expect(restored.status()).toBe("active");
    expect(restored.toSaved("VOTE")).toBe(snapshot);
    game.free();
    restored.free();
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, ready } from "@cabal/engine";
import type { OrderResultView, StateView } from "@cabal/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResolvedPhase } from "../lobby/room.js";
import { mergeRecords, missingPhases, recordFromFrame, recordsFromReplay } from "./history.js";
import { bookOf, piecesOf, sameOrders } from "./useDesk.js";

beforeAll(async () => {
  await ready(readFileSync(fileURLToPath(new URL("../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url))));
});

/** Resolve spring 1901 with France moving to Burgundy, as the server's frame would report it. */
function spring() {
  const game = new Game();
  const before = game.state();
  const outcome = game.process(game.normaliseOrders({ orders: { FRANCE: ["A PAR - BUR"] } }));
  const resolved: ResolvedPhase = {
    phase: "S1901M",
    results: outcome.results as OrderResultView[],
    dislodged: outcome.dislodged,
    standoffs: outcome.standoffs,
    civil_disorder: outcome.civil_disorder,
    summary: { phase: "S1901M", adjudicatedAt: 1, centers: {} },
    before: before as unknown as StateView,
  };
  return { game, resolved };
}

describe("a live game's history", () => {
  it("makes a phase record from a results frame, keeping only the orders someone wrote", () => {
    const { resolved } = spring();
    const record = recordFromFrame(resolved)!;
    expect(record.phase).toBe("S1901M");
    expect(Object.values(record.orders.FRANCE ?? {})).toEqual(["A PAR - BUR"]);
    expect(record.outcome.results.some((r) => r.order === "A PAR - BUR" && r.ok)).toBe(true);
    expect(recordFromFrame({ ...resolved, before: null })).toBeNull();
  });

  it("reads the server's saved game, its extra cabal block and all", () => {
    const { game } = spring();
    const saved = { ...JSON.parse(game.toSaved("K7Q2XZ")), cabal: { protocol: 2, status: "active", finished: null, pledges: [], history: [] } };
    const records = recordsFromReplay(JSON.stringify(saved));
    expect(records.map((r) => r.phase)).toEqual(["S1901M"]);
  });

  it("prefers the saved game's record and fills in phases it does not have yet, in order", () => {
    const { game, resolved } = spring();
    const saved = recordsFromReplay(game.toSaved("K7Q2XZ"));
    const fall: ResolvedPhase = { ...resolved, phase: "F1901M", before: { ...resolved.before!, name: "F1901M" } };
    const merged = mergeRecords(saved, { S1901M: resolved, F1901M: fall }, ["S1901M", "F1901M"]);
    expect(merged.map((r) => r.phase)).toEqual(["S1901M", "F1901M"]);
    expect(merged[0]).toBe(saved[0]);
  });
});

describe("when the saved game is worth fetching", () => {
  it("only while a phase in the history can be drawn from neither the saved game nor the frames seen", () => {
    const { game, resolved } = spring();
    const saved = recordsFromReplay(game.toSaved("K7Q2XZ"));
    const fall: ResolvedPhase = { ...resolved, phase: "F1901M", before: { ...resolved.before!, name: "F1901M" } };
    // Arriving at a game in progress: nothing yet.
    expect(missingPhases([], {}, ["S1901M", "F1901M"])).toEqual(["S1901M", "F1901M"]);
    // Saved game loaded, then a phase resolved while watching: its frame is enough.
    expect(missingPhases(saved, { F1901M: fall }, ["S1901M", "F1901M"])).toEqual([]);
    // Back from a gap in the connection, with a phase never seen.
    expect(missingPhases(saved, { F1901M: { ...fall, before: null } }, ["S1901M", "F1901M"])).toEqual(["F1901M"]);
  });
});

describe("the order desk's helpers", () => {
  it("keys a seat's orders as the order book does, and compares books by their orders", () => {
    expect(bookOf("FRANCE", ["A PAR - BUR", "F BRE H"], "M")).toEqual({ "A PAR": "A PAR - BUR", "F BRE": "F BRE H" });
    expect(bookOf("FRANCE", ["A PAR B", "WAIVE"], "A")).toMatchObject({ "B:PAR": "A PAR B" });
    expect(sameOrders({ a: "X", b: "Y" }, { c: "Y", d: "X" })).toBe(true);
    expect(sameOrders({ a: "X" }, { a: "Y" })).toBe(false);
  });

  it("finds the pieces on the board, dislodged ones marked", () => {
    const pieces = piecesOf({ units: { FRANCE: ["A PAR", "*F BRE"] } });
    expect(pieces).toEqual([
      { power: "FRANCE", unit: "A PAR", province: "PAR", dislodged: false },
      { power: "FRANCE", unit: "F BRE", province: "BRE", dislodged: true },
    ]);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { tidyLegal } from "../game/saved.js";
import { filedLine, settledBook } from "./settle.js";

beforeAll(async () => {
  await ready(readFileSync(fileURLToPath(new URL("../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url))));
});

describe("settledBook: readying files a decision for everything left open", () => {
  it("holds every unordered unit in a movement phase", () => {
    const legal = { "A PAR": ["A PAR H", "A PAR - BUR"], "F BRE": ["F BRE H"], "A MAR": ["A MAR H"] };
    expect(settledBook({ kind: "M", book: { "A PAR": "A PAR - BUR" }, legal, allowance: 0 })).toEqual({
      "A PAR": "A PAR - BUR",
      "F BRE": "F BRE H",
      "A MAR": "A MAR H",
    });
  });

  it("disbands every dislodged unit left without a retreat", () => {
    const legal = { "A VIE": ["A VIE R BOH", "A VIE D"], "F TRI": ["F TRI R ALB", "F TRI D"] };
    expect(settledBook({ kind: "R", book: { "F TRI": "F TRI R ALB" }, legal, allowance: 0 })).toEqual({ "F TRI": "F TRI R ALB", "A VIE": "A VIE D" });
  });

  it("waives the builds a player left unchosen", () => {
    const legal = { "": ["A VIE B", "F TRI B", "A BUD B"] };
    expect(settledBook({ kind: "A", book: {}, legal, allowance: 2 })).toEqual({ "WAIVE:0": "WAIVE", "WAIVE:1": "WAIVE" });
    expect(settledBook({ kind: "A", book: { "B:VIE": "A VIE B" }, legal, allowance: 2 })).toEqual({ "B:VIE": "A VIE B", "WAIVE:0": "WAIVE" });
  });

  it("files the rules' own disbands when a player owes some and chose none", () => {
    const legal = { "": ["A VIE D", "A BUD D", "F TRI D"] };
    const out = settledBook({ kind: "A", book: {}, legal, allowance: -1, disorder: () => ["F TRI"] });
    expect(out).toEqual({ "D:TRI": "F TRI D" });
    // One chosen, one more owed: the rules pick the other.
    expect(settledBook({ kind: "A", book: { "D:VIE": "A VIE D" }, legal, allowance: -2, disorder: () => ["A VIE", "A BUD"] })).toEqual({
      "D:VIE": "A VIE D",
      "D:BUD": "A BUD D",
    });
  });

  it("returns the same book when nothing is left open, so nothing is refiled", () => {
    const book = { "A PAR": "A PAR H" };
    expect(settledBook({ kind: "M", book, legal: { "A PAR": ["A PAR H"] }, allowance: 0 })).toBe(book);
    const winter = { "B:PAR": "A PAR B" };
    expect(settledBook({ kind: "A", book: winter, legal: { "": ["A PAR B"] }, allowance: 1 })).toBe(winter);
    expect(settledBook({ kind: "A", book: {}, legal: {}, allowance: 0 })).toEqual({});
  });

  it("asks the engine which units civil disorder removes, and those are the ones filed", () => {
    // Austria, its home centres lost, holds four units on two centres: two disbands owed.
    const start = new Game().state();
    const state = {
      ...start,
      name: "W1901A",
      units: { ...start.units, AUSTRIA: ["A VIE", "A BUD", "F TRI", "A GAL"], RUSSIA: [] },
      centers: { ...start.centers, AUSTRIA: ["VIE", "BUD"], RUSSIA: ["MOS", "STP", "SEV", "WAR"] },
    };
    const game = Game.fromState(state);
    const l = game.legal("AUSTRIA");
    expect(l.allowance).toBe(-2);
    const legal = tidyLegal(l.by_unit, "A");
    const out = settledBook({ kind: "A", book: {}, legal, allowance: l.allowance, disorder: () => game.preview({ orders: { AUSTRIA: [] } }).civil_disorder });
    const removed = game.preview({ orders: { AUSTRIA: [] } }).civil_disorder;
    expect(removed).toHaveLength(2);
    expect(Object.values(out).sort()).toEqual(removed.map((u) => `${u} D`).sort());
    // And the server takes them as orders: every one is legal.
    expect(game.validateOrders("AUSTRIA", Object.values(out)).every((v) => v.legal)).toBe(true);
  });
});

describe("filedLine: the desk says what readying now would mean, for each kind of phase", () => {
  it("names holds, disbands and waives instead of 'your units hold' everywhere", () => {
    expect(filedLine({ kind: "M", allowance: 0, given: 0, due: 3 })).toBe("No orders on file: your units hold.");
    expect(filedLine({ kind: "R", allowance: 0, given: 0, due: 1 })).toBe("No retreats on file: your dislodged units disband.");
    expect(filedLine({ kind: "A", allowance: 2, given: 0, due: 2 })).toBe("No builds chosen: they are waived when you are ready.");
    expect(filedLine({ kind: "A", allowance: -1, given: 0, due: 1 })).toBe("No disbands chosen: when you are ready, the rules choose which units go.");
    expect(filedLine({ kind: "A", allowance: 0, given: 0, due: 0 })).toBe("Nothing to build or disband this winter.");
  });

  it("says what happens to what is still open when only some is on file", () => {
    expect(filedLine({ kind: "M", allowance: 0, given: 3, due: 3 })).toBe("Your orders are on file with the server.");
    expect(filedLine({ kind: "M", allowance: 0, given: 1, due: 3 })).toBe("Your orders are on file. Units without one hold.");
    expect(filedLine({ kind: "A", allowance: 2, given: 1, due: 2 })).toBe("Your builds are on file. Any you leave unchosen are waived.");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, type State, preview, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { type OrderBook, flatten } from "../book.js";
import { receiptFor } from "../receipts.js";
import { explainPhase, explainerFor, hasWhy, indexOfUnit, namePlaces, whyOf, whyOfResult } from "./explain.js";
import { predict } from "./whatIf.js";

beforeAll(async () => {
  await ready(readFileSync(fileURLToPath(new URL("../../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url))));
});

const names = {
  BUR: { name: "Burgundy" },
  PAR: { name: "Paris" },
  MUN: { name: "Munich" },
  ENG: { name: "English Channel" },
  LON: { name: "London" },
  STP: { name: "St Petersburg" },
};

const opening = () => new Game().state();

/** The opening position with these units instead (`{ FRANCE: ["A PAR"] }`). */
function position(units: Record<string, string[]>, name = "S1901M"): State {
  const s = opening();
  return { ...s, name, units: { ...Object.fromEntries(Object.keys(s.units).map((p) => [p, []])), ...units } };
}

function explainFor(state: State, orders: OrderBook, power: string, unit: string) {
  const ex = explainPhase({ phase: state.name, state, orders });
  if (!ex) throw new Error("no explanation");
  const why = whyOf(ex, indexOfUnit(ex, power, unit), names);
  if (!why) throw new Error(`no why for ${unit}`);
  return why;
}

describe("why a move failed", () => {
  it("names the unit it bounced with and both strengths, even though a plain bounce has no edges", () => {
    const why = explainFor(opening(), { FRANCE: { "A PAR": "A PAR - BUR" }, GERMANY: { "A MUN": "A MUN - BUR" } }, "FRANCE", "A PAR");
    expect(why.ok).toBe(false);
    expect(why.verdict).toBe("Bounced");
    expect(why.contest?.mine).toEqual({ role: "This move", unit: "A PAR", strength: 1 });
    expect(why.contest?.against).toContainEqual({ role: "Also moving in", unit: "A MUN", strength: 1 });
    expect(why.sentence).toContain("A MUN");
    expect(why.sentence).toContain("Burgundy");
    expect(why.highlight.focus).toBe("PAR");
    expect(why.highlight.against).toContain("MUN");
    expect(why.highlight.units).toEqual(expect.arrayContaining(["A PAR", "A MUN"]));
  });

  it("counts a support that held and shows who it came from", () => {
    const why = explainFor(
      opening(),
      { FRANCE: { "A PAR": "A PAR - BUR", "A MAR": "A MAR S A PAR - BUR" }, GERMANY: { "A MUN": "A MUN - BUR" } },
      "GERMANY",
      "A MUN",
    );
    expect(why.contest?.against).toContainEqual({ role: "Also moving in", unit: "A PAR", strength: 2 });
    const won = explainFor(
      opening(),
      { FRANCE: { "A PAR": "A PAR - BUR", "A MAR": "A MAR S A PAR - BUR" }, GERMANY: { "A MUN": "A MUN - BUR" } },
      "FRANCE",
      "A PAR",
    );
    expect(won.ok).toBe(true);
    expect(won.supports).toEqual([{ unit: "A MAR", counted: true, code: "ok", cutBy: [] }]);
    expect(won.highlight.allies).toEqual(["MAR"]);
  });

  it("names who cut a support", () => {
    const state = position({ FRANCE: ["A PAR", "A MAR"], GERMANY: ["A MUN", "A RUH"], ITALY: ["A PIE"] });
    const orders = {
      FRANCE: { "A PAR": "A PAR - BUR", "A MAR": "A MAR S A PAR - BUR" },
      ITALY: { "A PIE": "A PIE - MAR" },
      GERMANY: { "A MUN": "A MUN - BUR", "A RUH": "A RUH S A MUN - BUR" },
    };
    const support = explainFor(state, orders, "FRANCE", "A MAR");
    expect(support.ok).toBe(false);
    expect(support.verdict).toBe("Support cut");
    expect(support.cutBy).toEqual(["A PIE"]);
    expect(support.highlight.against).toContain("PIE");
    const move = explainFor(state, orders, "FRANCE", "A PAR");
    expect(move.supports).toEqual([{ unit: "A MAR", counted: false, code: "cut", cutBy: ["A PIE"] }]);
  });

  it("notes a convoy paradox and the orders in its circle", () => {
    // DATC 6.F.14-style: the convoyed army attacks the fleet whose support would dislodge a convoying fleet.
    const state = position({ FRANCE: ["A BRE", "F ENG"], ENGLAND: ["F LON", "F WAL"] });
    const orders = {
      FRANCE: { "A BRE": "A BRE - LON VIA", "F ENG": "F ENG C A BRE - LON" },
      ENGLAND: { "F LON": "F LON S F WAL - ENG", "F WAL": "F WAL - ENG" },
    };
    const ex = explainPhase({ phase: state.name, state, orders })!;
    expect(ex.cycles.length).toBeGreaterThan(0);
    const why = whyOf(ex, indexOfUnit(ex, "FRANCE", "A BRE"), names)!;
    expect(why.cycle?.kind).toBe("convoy_paradox");
    expect(why.cycle?.note).toContain("Szykman");
    expect(why.cycle?.orders.length).toBeGreaterThanOrEqual(2);
    expect(why.convoys.map((c) => c.unit)).toContain("F ENG");
  });
});

describe("the panel agrees with the receipt", () => {
  it("stamps each order in a convoy paradox the way its receipt does (DATC 6.F.16, Pandin's paradox)", () => {
    const state = position({ ENGLAND: ["F LON", "F WAL"], FRANCE: ["A BRE", "F ENG"], GERMANY: ["F NTH", "F BEL"] });
    const orders = {
      ENGLAND: { "F LON": "F LON S F WAL - ENG", "F WAL": "F WAL - ENG" },
      FRANCE: { "A BRE": "A BRE - LON VIA", "F ENG": "F ENG C A BRE - LON" },
      GERMANY: { "F NTH": "F NTH S F BEL - ENG", "F BEL": "F BEL - ENG" },
    };
    const out = preview(state, { orders: flatten(orders) });
    const ex = explainPhase({ phase: state.name, state, orders })!;
    const failed = out.results.filter((r) => !r.ok);
    expect(failed.map((r) => r.unit)).toEqual(expect.arrayContaining(["F BEL", "A BRE"]));
    for (const r of failed) {
      const why = whyOf(ex, indexOfUnit(ex, r.power, r.unit))!;
      expect(`${r.unit}: ${why.verdict}`).toBe(`${r.unit}: ${receiptFor(r, state.name, undefined, out.results).verdict}`);
    }
    // The circle is still explained.
    expect(whyOf(ex, indexOfUnit(ex, "FRANCE", "A BRE"))!.cycle?.kind).toBe("convoy_paradox");
  });

  it("shows no holding ledger for an order nothing came at", () => {
    // Tyrolia cannot reach Marseilles, so its support is illegal and it simply holds, unattacked.
    const state = position({ AUSTRIA: ["A TYR"], ITALY: ["A PIE"] });
    const why = explainFor(state, { AUSTRIA: { "A TYR": "A TYR S A PIE - MAR" } }, "AUSTRIA", "A TYR");
    expect(why.ok).toBe(false);
    expect(why.defence).toBeNull();
  });
});

describe("phases the engine does not explain", () => {
  it("are left to the result's own account", () => {
    expect(explainPhase({ phase: "F1901R", state: opening(), orders: {} })).toBeNull();
    const why = whyOfResult(
      { power: "AUSTRIA", unit: "F TRI", order: "F TRI R ALB", ok: false, code: "bounce", reason: "bounced with VEN", by: ["A VEN"] },
      "F1901R",
    );
    expect(why.verdict).toBe("Bounced");
    expect(why.highlight.against).toEqual(["VEN"]);
  });

  it("only offers a why for orders that went wrong", () => {
    expect(hasWhy({ power: "F", unit: "A PAR", order: "A PAR - BUR", ok: true, code: "ok", reason: "" })).toBe(false);
    expect(hasWhy({ power: "F", unit: "A PAR", order: "A PAR D", ok: false, code: "disband", reason: "disbanded" })).toBe(false);
    expect(hasWhy({ power: "F", unit: "A PAR", order: "A PAR - BUR", ok: false, code: "bounce", reason: "" })).toBe(true);
  });
});

describe("namePlaces", () => {
  it("names provinces and coasts but leaves units in notation", () => {
    expect(namePlaces("A PAR bounced in BUR with A MUN.", names)).toBe("A PAR bounced in Burgundy with A MUN.");
    expect(namePlaces("F LON moved to STP/NC.", names)).toBe("F LON moved to St Petersburg (north coast).");
    expect(namePlaces("A PAR moved to XYZ.", names)).toBe("A PAR moved to XYZ.");
  });
});

describe("what if", () => {
  it("predicts exactly what adjudicating the same orders gives, and changes nothing", () => {
    const game = new Game();
    const book = { FRANCE: { "A PAR": "A PAR - BUR" }, GERMANY: { "A MUN": "A MUN - BUR" } };
    const before = game.state();
    const prediction = predict(game.state(), book)!;
    expect(game.state()).toEqual(before);
    expect(game.historyLength()).toBe(0);
    const real = game.process({ orders: { FRANCE: ["A PAR - BUR"], GERMANY: ["A MUN - BUR"] } });
    expect(prediction.outcome.results).toEqual(real.results);
    expect(prediction.outcome.standoffs).toEqual(["BUR"]);
    expect(prediction.explanation?.orders.length).toBe(real.results.length);
  });

  it("holds every unit nobody sketched an order for", () => {
    const p = predict(opening(), {})!;
    expect(p.outcome.results.every((r) => r.ok && r.order.endsWith(" H"))).toBe(true);
  });

  it("predicts retreats and builds too, without an explanation", () => {
    const g = new Game();
    g.process({ orders: { FRANCE: ["A PAR - PIC", "F BRE - MAO", "A MAR - SPA"] } });
    g.process({ orders: { FRANCE: ["A PIC - BEL", "F MAO - POR", "A SPA H"] } });
    const p = predict(g.state(), { FRANCE: { "B:PAR": "A PAR B" } })!;
    expect(p.explanation).toBeNull();
    expect(p.outcome.results.some((r) => r.order === "A PAR B" && r.ok)).toBe(true);
  });
});

describe("explainerFor", () => {
  it("uses the engine's account for a movement phase and the result's own for the rest", () => {
    const state = position({ FRANCE: ["A PAR"], GERMANY: ["A MUN"] });
    const orders = { FRANCE: { "A PAR": "A PAR - BUR" }, GERMANY: { "A MUN": "A MUN - BUR" } };
    const outcome = preview(state, { orders: flatten(orders) });
    const explain = explainerFor(outcome.results, state.name, explainPhase({ phase: state.name, state, orders }), names);
    const bounced = explain(outcome.results.find((r) => r.power === "FRANCE")!)!;
    expect(bounced.verdict).toBe(explainFor(state, orders, "FRANCE", "A PAR").verdict);
    expect(bounced.contest?.against.map((s) => s.unit)).toContain("A MUN");
    // Without an explanation (a retreat or a winter) the receipt's words stand.
    const plain = explainerFor(outcome.results, "F1901R", null, names)(outcome.results[0]!)!;
    expect(plain.contest).toBeNull();
    expect(plain.verdict).toBe(receiptFor(outcome.results[0]!, "F1901R", names, outcome.results).verdict);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Game,
  POWERS,
  type OrdersByPower,
  type State,
  buildInfo,
  explainPreview,
  mapInfo,
  preview,
  ready,
  validateOrders,
  verifySaved,
  version,
} from "./index.js";

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL("../pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasmPath));
});

/** A board with exactly these units, in Spring 1901. */
function board(units: Record<string, string[]>): State {
  const state = new Game().state();
  state.units = units;
  return state;
}

/** Fleet-heavy midgame: 34 units, 18 fleets at sea (the engine's legal-order bench). */
const MIDGAME: Record<string, string[]> = {
  ENGLAND: ["F NAO", "F NWG", "F NTH", "F IRI", "A NWY", "A LON"],
  FRANCE: ["F ENG", "F MAO", "F WES", "A BRE", "A SPA"],
  GERMANY: ["F HEL", "F SKA", "F BAL", "A DEN", "A KIE"],
  RUSSIA: ["F BOT", "F BLA", "A STP", "A SEV"],
  ITALY: ["F LYO", "F TYS", "F ION", "A NAP", "A TUN"],
  TURKEY: ["F AEG", "F EAS", "A SMY", "A BUL", "A GRE"],
  AUSTRIA: ["F ADR", "A TRI", "A ALB", "A SER"],
};

describe("build identity", () => {
  it("reports what was built and what it can do", () => {
    const info = buildInfo();
    expect(info.version).toBe(version());
    expect(info.commit).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
    expect(info.target).toBe("wasm32-unknown-unknown");
    // the WebAssembly build has its own profile, and says so
    expect(info.profile).toBe("wasm-release");
    expect(info.opt_level).toMatch(/^[0-3sz]$/);
    expect(info.maps).toEqual(["standard", "duel"]);
    expect(info.rulebooks).toEqual(["2023", "1982", "1971", "dptg"]);
    expect(info.features).toEqual(
      expect.arrayContaining(["validate", "explain", "preview", "legal_moves", "tolerant_process", "maps", "saved_rejections"]),
    );
    // every advertised map really loads
    for (const map of info.maps) expect(new Game(undefined, map).mapName()).toBe(map);
    // every advertised rulebook really loads
    for (const rulebook of info.rulebooks) expect(new Game(rulebook).rulebook()).toBe(rulebook);
  });
});

describe("validateOrders", () => {
  it("judges each order against the board and never throws over one", () => {
    const game = new Game();
    const verdicts = game.validateOrders("FRANCE", [
      "a par - bur",
      "A MAR - MOS",
      "F BRE - PAR",
      "A MUN H",
      "A BUR H",
      "what is this",
      "GER: A PAR H",
      "A PAR B",
    ]);
    expect(verdicts.map((v) => v.code)).toEqual([
      "ok",
      "unreachable",
      "unreachable",
      "foreign_unit",
      "no_unit",
      "unparseable",
      "wrong_power",
      "wrong_phase",
    ]);
    expect(verdicts[0]).toEqual({
      input: "a par - bur",
      canonical: "A PAR - BUR",
      legal: true,
      code: "ok",
      reason: "The order is legal.",
      unit: "A PAR",
    });
    expect(verdicts[1]).toMatchObject({ canonical: "A MAR - MOS", legal: false, unit: "A MAR" });
    expect(verdicts[1]?.reason).toBe(
      "The destination is not adjacent and no chain of fleets could convoy there.",
    );
    expect(verdicts[5]).toMatchObject({ canonical: null, unit: null, legal: false });
    for (const v of verdicts) {
      expect(v.reason).toMatch(/\.$/);
      expect(v.legal).toBe(v.code === "ok");
    }
    expect(() => game.validateOrders("ATLANTIS", [])).toThrow(/unknown power/);
    // asking changes nothing
    expect(game.phase()).toBe("S1901M");
    expect(game.historyLength()).toBe(0);
  });

  it("flags two orders for one unit on both", () => {
    const verdicts = new Game().validateOrders("FRANCE", ["A PAR - BUR", "A PAR - PIC", "A MAR H"]);
    expect(verdicts.map((v) => v.code)).toEqual(["duplicate_order", "duplicate_order", "ok"]);
  });

  it("agrees with adjudication: legal exactly when the resolver accepts the order", () => {
    const game = new Game();
    for (const power of POWERS) {
      const legal = Object.values(game.legal(power).by_unit).flat();
      const verdicts = game.validateOrders(power, legal);
      // every unit has many orders, so each is a duplicate here; one at a time each is legal
      expect(verdicts.every((v) => v.code === "duplicate_order" || v.code === "ok")).toBe(true);
      for (const order of legal.slice(0, 12)) {
        const [verdict] = game.validateOrders(power, [order]);
        expect(verdict).toMatchObject({ legal: true, canonical: order });
      }
    }
    const illegal = ["A PAR - MOS", "A PAR S A MUN", "F BRE C A PAR - LON", "A PAR - PAR"];
    for (const order of illegal) {
      const [verdict] = game.validateOrders("FRANCE", [order]);
      expect(verdict?.legal).toBe(false);
      const out = preview(game.state(), { orders: { FRANCE: [order] } });
      const result = out.results.find((r) => r.unit === verdict?.unit);
      expect(result).toMatchObject({ code: "illegal", illegal: verdict?.code, submitted: verdict?.canonical });
    }
  });

  it("knows retreat restrictions and build allowances", () => {
    const game = Game.fromState(
      board({ FRANCE: ["A BUR", "A RUH"], GERMANY: ["A MUN", "A BER"], RUSSIA: ["A WAR"], ITALY: ["A TYR"] }),
    );
    game.process({
      orders: {
        FRANCE: ["A BUR - MUN", "A RUH S A BUR - MUN"],
        GERMANY: ["A BER - SIL"],
        RUSSIA: ["A WAR - SIL"],
      },
    });
    expect(game.phase()).toBe("S1901R");
    const codes = (orders: string[]) => orders.map((o) => game.validateOrders("GERMANY", [o])[0]?.code);
    expect(codes(["A MUN R BUR", "A MUN R SIL", "A MUN R TYR", "A MUN R PAR", "A MUN R BOH", "A MUN D", "A BER R PRU"])).toEqual([
      "attacker_origin",
      "standoff",
      "occupied",
      "unreachable",
      "ok",
      "ok",
      "not_dislodged",
    ]);
    expect(game.validateOrders("FRANCE", ["A MUN R BOH"])[0]?.code).toBe("foreign_unit");
    expect(game.validateOrders("GERMANY", ["mun r boh"])[0]).toMatchObject({
      canonical: "A MUN R BOH",
      unit: "A MUN",
    });

    // stateless form, on an adjustment board: France owns three centres and has two units
    const state = new Game().state();
    state.name = "W1901A";
    state.units = { ...state.units, FRANCE: ["F BRE", "A PAR"] };
    const verdicts = validateOrders(state, "FRANCE", ["F MAR B", "A MAR B", "A PAR B"]);
    expect(verdicts.map((v) => v.code)).toEqual(["ok", "allowance_used", "allowance_used"]);
    expect(validateOrders(state, "FRANCE", ["A MUN B"])[0]?.code).toBe("not_home_center");
    expect(validateOrders(state, "ENGLAND", ["WAIVE"])[0]?.code).toBe("nothing_to_do");
  });
});

describe("process", () => {
  it("sets bad orders aside with a reason and adjudicates the rest", () => {
    const game = new Game();
    const outcome = game.process({
      orders: {
        FRANCE: ["complete garbage", "A PAR - BUR", "A MUN - RUH", "A PAR B"],
        GERMANY: ["A MUN - BUR", "FRA: A MAR - SPA"],
        ATLANTIS: ["A PAR H"],
      },
    });
    expect(outcome.phase).toBe("S1901M");
    expect((outcome.rejected ?? []).map((r) => [r.power, r.input, r.code])).toEqual([
      ["ATLANTIS", "A PAR H", "unknown_power"],
      ["FRANCE", "complete garbage", "unparseable"],
      ["FRANCE", "A MUN - RUH", "foreign_unit"],
      ["FRANCE", "A PAR B", "wrong_phase"],
      ["GERMANY", "FRA: A MAR - SPA", "wrong_power"],
    ]);
    for (const r of outcome.rejected ?? []) expect(r.reason).toMatch(/\.$/);
    // the readable orders were still judged: Paris and Munich bounce in Burgundy
    expect(outcome.results.find((r) => r.unit === "A PAR")).toMatchObject({ code: "bounce", by: ["A MUN"] });
    expect(outcome.results.find((r) => r.unit === "A MUN")).toMatchObject({ code: "bounce", by: ["A PAR"] });
    expect(game.phase()).toBe("F1901M");
    // the record of the phase keeps what was set aside
    expect(game.outcome(0).rejected).toEqual(outcome.rejected);
  });

  it("cannot be used to void a rival's order", () => {
    const game = new Game();
    const outcome = game.process({ orders: { GERMANY: ["A MUN - RUH"], FRANCE: ["A MUN - BUR", "A MUN H"] } });
    expect(outcome.results.find((r) => r.unit === "A MUN")).toMatchObject({ ok: true, order: "A MUN - RUH" });
    expect((outcome.rejected ?? []).map((r) => r.code)).toEqual(["foreign_unit", "foreign_unit"]);
  });

  it("keeps what was submitted when an order is thrown out as illegal", () => {
    const game = new Game();
    const outcome = game.process({ orders: { FRANCE: ["A PAR - MOS", "A MAR - SPA", "A MAR - BUR"] } });
    expect(outcome.rejected).toEqual([]);
    expect(outcome.results.find((r) => r.unit === "A PAR")).toMatchObject({
      ok: false,
      order: "A PAR H",
      code: "illegal",
      illegal: "unreachable",
      submitted: "A PAR - MOS",
    });
    const mar = outcome.results.find((r) => r.unit === "A MAR");
    expect(mar).toMatchObject({ code: "illegal", illegal: "duplicate_order" });
    expect(mar?.submitted).toBe("A MAR - SPA / A MAR - BUR");
    // the log form hosts already match on is unchanged; the words are in `summary`
    expect(mar?.reason).toBe("illegal (DuplicateOrder), holds");
    expect(mar?.summary).toBe("illegal order (the unit was given more than one order), the unit holds");
    expect(outcome.results.find((r) => r.unit === "F BRE")).toMatchObject({ illegal: null, submitted: null, by: [] });
  });

  it("gives every way a move fails its own code", () => {
    const codeOf = (units: Record<string, string[]>, orders: OrdersByPower["orders"], unit: string) =>
      preview(board(units), { orders }).results.find((r) => r.unit === unit);
    expect(codeOf({ FRANCE: ["A PAR"], GERMANY: ["A MUN"] }, { FRANCE: ["A PAR - BUR"], GERMANY: ["A MUN - BUR"] }, "A PAR")).toMatchObject({
      code: "bounce",
      reason: "bounced with MUN",
      summary: "bounced with A MUN",
      by: ["A MUN"],
    });
    expect(codeOf({ FRANCE: ["A PAR"], GERMANY: ["A BUR"] }, { FRANCE: ["A PAR - BUR"] }, "A PAR")).toMatchObject({
      code: "repelled",
      by: ["A BUR"],
    });
    expect(
      codeOf({ FRANCE: ["A PAR"], GERMANY: ["A BUR"] }, { FRANCE: ["A PAR - BUR"], GERMANY: ["A BUR - PAR"] }, "A PAR"),
    ).toMatchObject({ code: "head_to_head", by: ["A BUR"] });
    expect(codeOf({ FRANCE: ["A PAR", "A BUR"] }, { FRANCE: ["A PAR - BUR"] }, "A PAR")).toMatchObject({
      code: "own_unit",
      by: ["A BUR"],
    });
    expect(codeOf({ ENGLAND: ["A LON", "F NTH"] }, { ENGLAND: ["A LON - BEL"] }, "A LON")).toMatchObject({
      code: "no_path",
      by: [],
    });
  });

  it("reports retreat and adjustment failures in plain words", () => {
    const game = Game.fromState(board({ FRANCE: ["A BUR", "A RUH"], GERMANY: ["A MUN"] }));
    game.process({ orders: { FRANCE: ["A BUR - MUN", "A RUH S A BUR - MUN"] } });
    const retreat = game.process({ orders: { GERMANY: ["A MUN R BUR"] } });
    expect(retreat.results[0]).toMatchObject({
      unit: "A MUN",
      code: "illegal",
      illegal: "attacker_origin",
      reason: "illegal retreat (AttackerOrigin), disbanded",
      summary: "illegal retreat (a unit cannot retreat to the province its attacker came from), disbanded",
    });
  });
});

describe("preview", () => {
  it("answers any hypothetical order set and leaves the game alone", () => {
    const game = new Game();
    game.process({ orders: { FRANCE: ["A PAR - BUR"] } });
    const before = { saved: game.toSaved("g"), snapshot: game.snapshot(), state: game.state() };
    // orders for every power, including ones the asker does not own, and nonsense
    const guess = {
      orders: {
        FRANCE: ["A BUR - MUN", "A MAR S A BUR - MUN"],
        GERMANY: ["A MUN - BUR", "A BER - KIE", "nonsense"],
        ITALY: ["A VEN - TYR"],
      },
    };
    const viaGame = game.preview(guess);
    const viaState = preview(game.state(), guess);
    expect(viaGame).toEqual(viaState);
    expect(viaGame.phase).toBe("F1901M");
    expect((viaGame.rejected ?? []).map((r) => r.code)).toEqual(["unparseable"]);
    expect(viaGame.results.find((r) => r.unit === "A BUR")?.code).toBe("head_to_head");
    expect(viaGame.results.find((r) => r.unit === "A MUN")?.code).toBe("head_to_head");
    // twice gives the same answer, and the game has not moved
    expect(game.preview(guess)).toEqual(viaGame);
    expect(game.phase()).toBe("F1901M");
    expect(game.historyLength()).toBe(1);
    expect(game.toSaved("g")).toBe(before.saved);
    expect(game.snapshot()).toBe(before.snapshot);
    expect(game.state()).toEqual(before.state);
    // and what it predicted is what then happens
    const real = game.process(guess);
    expect(real.results).toEqual(viaGame.results);
    expect(real.next).toEqual(viaGame.next);
  });

  it("previews retreats with their real restrictions and adjustments with their allowance", () => {
    const game = Game.fromState(board({ FRANCE: ["A BUR", "A RUH"], GERMANY: ["A MUN"] }));
    game.process({ orders: { FRANCE: ["A BUR - MUN", "A RUH S A BUR - MUN"] } });
    expect(game.phase()).toBe("S1901R");
    const good = game.preview({ orders: { GERMANY: ["A MUN R BOH"] } });
    expect(good.results[0]).toMatchObject({ ok: true, code: "ok" });
    expect(good.next.units["GERMANY"]).toEqual(["A BOH"]);
    const bad = preview(game.state(), { orders: { GERMANY: ["A MUN R BUR"] } });
    expect(bad.results[0]).toMatchObject({ ok: false, illegal: "attacker_origin" });
    expect(game.phase()).toBe("S1901R");

    const state = new Game().state();
    state.name = "W1901A";
    state.units = { ...state.units, FRANCE: ["F BRE", "A PAR"] };
    const builds = preview(state, { orders: { FRANCE: ["A MAR B", "F MAR B"] } });
    expect(builds.results.map((r) => [r.order, r.code, r.illegal])).toEqual([
      ["A MAR B", "ok", null],
      ["F MAR B", "illegal", "allowance_used"],
    ]);
    expect(builds.next.units["FRANCE"]).toContain("A MAR");
  });

  it("previews a finished game's position without reviving the game", () => {
    const game = new Game();
    game.declareDraw();
    expect(() => game.process({ orders: {} })).toThrow(/finished/);
    expect(game.preview({ orders: { FRANCE: ["A PAR - BUR"] } }).next.units["FRANCE"]).toContain("A BUR");
    expect(game.status()).toBe("draw");
  });
});

describe("explanations", () => {
  it("names the other unit and both strengths for a plain bounce", () => {
    const game = new Game();
    game.process({ orders: { FRANCE: ["A PAR - BUR"], GERMANY: ["A MUN - BUR"] } });
    const x = game.explain(0);
    expect(x.orders).toHaveLength(22);
    // the dependency trace is empty for this, the commonest failure
    expect(x.edges).toEqual([]);
    const par = x.orders.find((o) => o.unit === "A PAR");
    expect(par).toMatchObject({
      power: "FRANCE",
      order: "A PAR - BUR",
      ok: false,
      code: "bounce",
      by: ["A MUN"],
      attack: 1,
      opposition: { kind: "empty", unit: null, strength: 0, own_unit: false },
      rivals: [{ unit: "A MUN", strength: 1 }],
      supports: [],
      by_convoy: false,
      cycle: null,
    });
    expect(par?.sentence).toBe(
      "A PAR bounced in BUR with A MUN (strength 1): its own strength was 1, and a move only succeeds when it is the strongest.",
    );
    expect(x.orders.map((o) => o.index)).toEqual(x.orders.map((_, i) => i));
    expect(x.orders.every((o) => o.sentence.endsWith("."))).toBe(true);
  });

  it("shows which supports counted and who cut the others", () => {
    const x = explainPreview(
      board({ FRANCE: ["A PAR", "A MAR"], GERMANY: ["A BUR"], ITALY: ["A PIE", "A SPA"] }),
      {
        orders: {
          FRANCE: ["A PAR - BUR", "A MAR S A PAR - BUR"],
          ITALY: ["A PIE - MAR", "A SPA - MAR"],
        },
      },
    );
    const par = x.orders.find((o) => o.unit === "A PAR");
    const mar = x.orders.find((o) => o.unit === "A MAR");
    expect(mar).toMatchObject({ code: "cut", hold: 1 });
    expect(mar?.cut_by.sort()).toEqual(["A PIE", "A SPA"]);
    expect(par).toMatchObject({
      code: "repelled",
      attack: 1,
      opposition: { kind: "hold", unit: "A BUR", strength: 1, own_unit: false },
    });
    expect(par?.supports).toEqual([
      { unit: "A MAR", index: mar?.index, code: "cut", counted: false, cut_by: expect.arrayContaining(["A PIE", "A SPA"]) },
    ]);
    expect(par?.depends_on).toContain(mar?.index);
    expect(par?.sentence).toContain("Support from A MAR was cut by an attack from A PIE and A SPA.");
    const bur = x.orders.find((o) => o.unit === "A BUR");
    expect(bur).toMatchObject({ code: "ok", hold: 1, attacks: [{ unit: "A PAR", strength: 1, succeeded: false }] });
  });

  it("explains a broken convoy and a convoy paradox with its cycle", () => {
    const broken = explainPreview(board({ ENGLAND: ["A LON", "F NTH"], GERMANY: ["F HEL", "F SKA"] }), {
      orders: {
        ENGLAND: ["A LON - BEL", "F NTH C A LON - BEL"],
        GERMANY: ["F HEL - NTH", "F SKA S F HEL - NTH"],
      },
    });
    const lon = broken.orders.find((o) => o.unit === "A LON");
    expect(lon).toMatchObject({
      code: "no_path",
      by_convoy: true,
      convoy_path: false,
      convoys: [{ unit: "F NTH", code: "dislodged", dislodged_by: "F HEL" }],
    });
    expect(lon?.sentence).toBe("The convoy carrying A LON to BEL was broken: F NTH was dislodged by F HEL.");

    // DATC 6.F.16, Pandin's paradox
    const paradox = explainPreview(
      board({ ENGLAND: ["F LON", "F WAL"], FRANCE: ["A BRE", "F ENG"], GERMANY: ["F NTH", "F BEL"] }),
      {
        orders: {
          ENGLAND: ["F LON S F WAL - ENG", "F WAL - ENG"],
          FRANCE: ["A BRE - LON", "F ENG C A BRE - LON"],
          GERMANY: ["F NTH S F BEL - ENG", "F BEL - ENG"],
        },
      },
    );
    expect(paradox.cycles).toHaveLength(1);
    expect(paradox.cycles[0]?.kind).toBe("convoy_paradox");
    const eng = paradox.orders.find((o) => o.unit === "F ENG");
    expect(eng).toMatchObject({ code: "paradox", cycle: 0 });
    expect(paradox.cycles[0]?.members).toContain(eng?.index);
    expect(eng?.sentence).toContain("Szykman");
    for (const member of paradox.cycles[0]?.members ?? []) {
      expect(paradox.orders[member]?.cycle).toBe(0);
      expect(paradox.orders[member]?.depends_on.length).toBeGreaterThan(0);
    }
    expect(paradox.orders.find((o) => o.unit === "A BRE")).toMatchObject({ code: "no_path" });

    const circle = explainPreview(board({ TURKEY: ["F ANK", "A CON", "A SMY"] }), {
      orders: { TURKEY: ["F ANK - CON", "A CON - SMY", "A SMY - ANK"] },
    });
    expect(circle.cycles).toEqual([{ kind: "circular_movement", members: [0, 1, 2] }]);
    expect(circle.orders.every((o) => o.ok && o.sentence.includes("circular movement"))).toBe(true);
  });

  it("explains a hypothetical on the live game without touching it, and agrees with what happens", () => {
    const game = new Game();
    const orders = { orders: { RUSSIA: ["F SEV - BLA"], TURKEY: ["F ANK - BLA"], FRANCE: ["A PAR - MOS"] } };
    const guess = game.explainPreview(orders);
    expect(game.historyLength()).toBe(0);
    expect(guess).toEqual(explainPreview(game.state(), orders));
    expect(guess.orders.find((o) => o.unit === "A PAR")).toMatchObject({
      code: "illegal",
      illegal: "unreachable",
      submitted: "A PAR - MOS",
      sentence:
        "The order A PAR - MOS is illegal: the destination is not adjacent and no chain of fleets could convoy there. A PAR held instead.",
    });
    const outcome = game.process(orders);
    const real = game.explain(0);
    expect(real).toEqual(guess);
    // the explanation and the result agree order by order
    for (const [i, result] of outcome.results.entries()) {
      expect(real.orders[i]).toMatchObject({
        unit: result.unit,
        order: result.order,
        ok: result.ok,
        code: result.code,
        by: result.by,
      });
    }
    expect(() => game.explainPreview({ orders: {} })).not.toThrow();
  });

  it("refuses to explain a phase that is not a movement phase", () => {
    const game = Game.fromState(board({ FRANCE: ["A BUR", "A RUH"], GERMANY: ["A MUN"] }));
    game.process({ orders: { FRANCE: ["A BUR - MUN", "A RUH S A BUR - MUN"] } });
    expect(() => game.explainPreview({ orders: {} })).toThrow(/not a movement phase/);
    expect(() => explainPreview(game.state(), { orders: {} })).toThrow(/not a movement phase/);
  });
});

describe("legal moves", () => {
  it("gives every unit's options as data that matches the order text", () => {
    const game = new Game();
    const moves = game.legalMoves();
    expect(moves).toMatchObject({ phase: "S1901M", kind: "M", adjustments: {} });
    expect(moves.units).toHaveLength(22);
    const par = moves.units.find((u) => u.unit === "A PAR");
    expect(par).toMatchObject({ power: "FRANCE", province: "PAR", convoys: [], retreats: [] });
    expect(par?.moves.map((m) => m.to).sort()).toEqual(["BRE", "BUR", "GAS", "PIC"]);
    expect(par?.moves.every((m) => !m.via_convoy)).toBe(true);
    const stp = moves.units.find((u) => u.unit === "F STP/SC");
    expect(stp?.province).toBe("STP");
    expect(stp?.moves.map((m) => m.to).sort()).toEqual(["BOT", "FIN", "LVN"]);

    // the structured form and the text form are the same set of orders
    for (const power of POWERS) {
      const text = game.legal(power).by_unit;
      const mine = game.legalMoves(power).units;
      expect(mine.map((u) => u.unit).sort()).toEqual(Object.keys(text).sort());
      expect(mine).toEqual(moves.units.filter((u) => u.power === power));
      for (const u of mine) {
        const count =
          1 +
          u.moves.length +
          u.support_holds.length +
          u.support_moves.reduce((n, s) => n + s.units.length, 0) +
          u.convoys.reduce((n, c) => n + c.to.length, 0);
        expect(count).toBe(text[u.unit]?.length);
        for (const m of u.moves) expect(text[u.unit]).toContain(`${u.unit} - ${m.to}${m.via_convoy ? " VIA" : ""}`);
        for (const s of u.support_moves) expect(s.units.length).toBeGreaterThan(0);
      }
    }
    expect(() => game.legalMoves("ATLANTIS")).toThrow(/unknown power/);
  });

  it("answers for every power in one call, identically to seven calls", () => {
    for (const game of [new Game(), Game.fromState(board(MIDGAME))]) {
      const all = game.legalAll();
      expect(Object.keys(all).sort()).toEqual([...POWERS]);
      for (const power of POWERS) {
        const one = game.legal(power);
        expect(Object.keys(all[power]?.by_unit ?? {}).sort()).toEqual(Object.keys(one.by_unit).sort());
        for (const [unit, orders] of Object.entries(one.by_unit)) expect(all[power]?.by_unit[unit]).toEqual(orders);
      }
    }
  });

  it("lists convoys and coasts in the midgame", () => {
    const game = Game.fromState(board(MIDGAME));
    const moves = game.legalMoves();
    expect(moves.units).toHaveLength(34);
    const nth = moves.units.find((u) => u.unit === "F NTH");
    expect(nth?.convoys.find((c) => c.army === "LON")?.to).toContain("BEL");
    const lon = moves.units.find((u) => u.unit === "A LON");
    expect(lon?.moves).toContainEqual({ to: "BEL", via_convoy: true });
    const mao = moves.units.find((u) => u.unit === "F MAO");
    expect(mao?.moves.map((m) => m.to)).toEqual(expect.arrayContaining(["SPA/NC", "SPA/SC"]));
    expect(nth?.support_moves.find((s) => s.to === "YOR")?.units).toContain("LON");
    // one entry per destination and per army, never a repeated key
    for (const u of moves.units) {
      expect(new Set(u.support_moves.map((s) => s.to)).size).toBe(u.support_moves.length);
      expect(new Set(u.convoys.map((c) => c.army)).size).toBe(u.convoys.length);
    }
  });

  it("gives retreat destinations and build options as data", () => {
    const game = Game.fromState(board({ FRANCE: ["A BUR", "A RUH"], GERMANY: ["A MUN"] }));
    game.process({ orders: { FRANCE: ["A BUR - MUN", "A RUH S A BUR - MUN"] } });
    const retreats = game.legalMoves();
    expect(retreats.kind).toBe("R");
    expect(retreats.units).toHaveLength(1);
    expect(retreats.units[0]).toMatchObject({ power: "GERMANY", unit: "A MUN", province: "MUN" });
    expect(retreats.units[0]?.retreats).toContain("BOH");
    expect(retreats.units[0]?.retreats).not.toContain("BUR");
    expect(game.legalMoves("FRANCE").units).toEqual([]);

    const state = new Game().state();
    state.name = "W1901A";
    state.units = { ...state.units, FRANCE: ["A PAR"], RUSSIA: ["A WAR", "A MOS", "F SEV"] };
    const adjust = Game.fromState(state).legalMoves();
    expect(adjust.kind).toBe("A");
    expect(adjust.units).toEqual([]);
    expect(adjust.adjustments["FRANCE"]).toEqual({
      allowance: 2,
      builds: [
        { province: "BRE", army: true, fleets: ["BRE"] },
        { province: "MAR", army: true, fleets: ["MAR"] },
      ],
      disbands: [],
    });
    expect(adjust.adjustments["RUSSIA"]?.builds).toEqual([{ province: "STP", army: true, fleets: ["STP/NC", "STP/SC"] }]);
    expect(adjust.adjustments["ENGLAND"]).toEqual({ allowance: 0, builds: [], disbands: [] });
    expect(Object.keys(Game.fromState(state).legalMoves("FRANCE").adjustments)).toEqual(["FRANCE"]);
  });
});

describe("maps", () => {
  it("plays, saves and restores a game on the duel map", () => {
    expect(mapInfo().name).toBe("standard");
    const info = mapInfo("duel");
    expect(info.name).toBe("duel");
    expect(info.powers).toHaveLength(2);
    expect(() => new Game(undefined, "atlantis")).toThrow(/unknown map atlantis/);

    const game = new Game(undefined, "duel");
    expect(game.mapName()).toBe("duel");
    const powers = info.powers.map((p) => p.name.toUpperCase()).sort();
    expect(Object.keys(game.legalAll()).sort()).toEqual(powers);
    // every unit takes its first legal order; the phase adjudicates
    const orders: Record<string, string[]> = {};
    for (const [power, legal] of Object.entries(game.legalAll())) {
      orders[power] = Object.values(legal.by_unit).map((options) => options.find((o) => o.includes(" - ")) ?? options[0]!);
    }
    const outcome = game.process({ orders });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.rejected).toEqual([]);

    const saved = game.toSaved("duel-1");
    expect(JSON.parse(saved).map).toBe("duel");
    for (const loaded of [Game.resume(saved), Game.fromSaved(saved), Game.fromSnapshot(game.snapshot(), saved)]) {
      expect(loaded.mapName()).toBe("duel");
      expect(loaded.state()).toEqual(game.state());
    }
    expect(verifySaved(saved).divergences).toEqual([]);

    // a state taken from a duel game is read against the duel map when it is named
    const again = Game.fromState(game.state(), undefined, "duel");
    expect(again.mapName()).toBe("duel");
    expect(again.legalAll()).toEqual(game.legalAll());
    expect(preview(game.state(), { orders: {} }, undefined, "duel").phase).toBe(game.phase());
  });
});

describe("the record of what was submitted", () => {
  it("keeps an illegal order as it was ordered, and reads it back the same after a restore", () => {
    const game = new Game();
    const live = game.process({ orders: { FRANCE: ["A PAR - MOS", "A MAR - SPA", "A MAR - BUR"] } });
    const of = (o: typeof live, unit: string) => o.results.find((r) => r.unit === unit);
    expect(of(live, "A PAR")).toMatchObject({ ok: false, illegal: "unreachable", submitted: "A PAR - MOS" });
    expect(of(live, "A MAR")).toMatchObject({ ok: false, illegal: "duplicate_order" });

    const saved = game.toSaved("illegal-1");
    const first = JSON.parse(saved).phases[0];
    expect(first.orders.FRANCE).toEqual(expect.arrayContaining(["A PAR - MOS", "A MAR - SPA", "A MAR - BUR"]));
    expect(first.orders.FRANCE).not.toContain("A PAR H");
    expect(first.results["A PAR"]).toEqual(["void"]);
    // the engine's own export verifies clean and replays
    expect(verifySaved(saved).divergences).toEqual([]);
    expect(Game.fromSaved(saved).toSaved("illegal-1")).toBe(saved);

    // a Durable Object wake must not turn the illegal order into a chosen hold
    const woken = Game.resume(saved);
    expect(woken.outcome(0).results).toEqual(live.results);
    expect(woken.explain(0)).toEqual(game.explain(0));
  });

  it("keeps rejected orders across a save and every way of loading it", () => {
    const game = new Game();
    const live = game.process({ orders: { FRANCE: ["complete garbage", "A PAR - BUR"], GERMANY: ["A PAR - PIC"] } });
    expect(live.rejected.map((r) => [r.power, r.input, r.code])).toEqual([
      ["FRANCE", "complete garbage", "unparseable"],
      ["GERMANY", "A PAR - PIC", "foreign_unit"],
    ]);
    game.process({ orders: {} });
    const saved = game.toSaved("rejected-1");
    expect(JSON.parse(saved).cabal.rejected.S1901M).toHaveLength(2);
    for (const loaded of [Game.resume(saved), Game.fromSaved(saved), Game.fromSnapshot(game.snapshot(), saved)]) {
      expect(loaded.outcome(0).rejected).toEqual(live.rejected);
      expect(loaded.outcome(1).rejected).toEqual([]);
      expect(loaded.toSaved("rejected-1")).toBe(saved);
    }
    expect(verifySaved(saved).divergences).toEqual([]);
    // a what-if never leaves anything on the game
    game.preview({ orders: { FRANCE: ["more garbage"] } });
    expect(game.toSaved("rejected-1")).toBe(saved);
  });
});

describe("a host's cabal block", () => {
  const entry = { id: "p1", pledger: "FRANCE", audience: "ALL", phase: "S1901M", sealed: true, commitment: "ab", nonce: "cd", orders: ["A PAR - BUR"], receipt: "kept" };
  const blocks: [string, unknown][] = [
    ["the server's summary", { protocol: 3, status: "active", finished: null, pledges: [entry], history: [{ phase: "S1901M" }] }],
    ["a pledge of another shape", { protocol: 3, pledges: [{ id: "p1", by: "FRANCE", text: "I will not attack" }] }],
    ["a receipt the engine does not know", { protocol: 3, pledges: [{ ...entry, receipt: "invalid" }] }],
    ["a pledge without a phase", { protocol: 3, pledges: [{ ...entry, phase: undefined }] }],
    ["a string rulebook", { protocol: 3, rulebook: "2023", status: "active" }],
    ["a string outcome", { protocol: 3, outcome: "draw" }],
    ["a string", "v1"],
    ["an array", [1, 2]],
  ];
  it.each(blocks)("does not stop the file loading: %s", (_, cabal) => {
    const game = new Game("1971");
    game.process({ orders: { FRANCE: ["A PAR - BUR"] } });
    const json = JSON.stringify({ ...JSON.parse(game.toSaved("host-1")), cabal });
    for (const loaded of [Game.fromSaved(json), Game.resume(json)]) {
      expect(loaded.state()).toEqual(game.state());
      expect(loaded.rulebook()).toBe("1971");
    }
    expect(verifySaved(json).divergences).toEqual([]);
  });

  it("still loads the engine's own block when a newer engine wrote more into it", () => {
    const game = new Game();
    game.process({ orders: { FRANCE: ["A PAR - BUR"] } });
    const own = JSON.parse(game.toSaved("future-1"));
    const future = { ...own, cabal: { ...own.cabal, outcome: { result: "abandoned" }, rulebook: { ...own.cabal.rulebook, some_new_rule: true } } };
    for (const loaded of [Game.fromSaved(JSON.stringify(future)), Game.resume(JSON.stringify(future))]) {
      expect(loaded.state()).toEqual(game.state());
      expect(loaded.status()).toBe("active");
    }
  });
});

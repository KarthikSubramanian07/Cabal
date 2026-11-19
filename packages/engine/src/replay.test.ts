import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Game, pledgeReceipt, preview, ready, verifySaved, version } from "./index.js";
import type { State } from "./index.js";

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL("../pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasmPath));
});

/** A board with exactly these units, at Spring 1901. */
function board(units: Record<string, string[]>): Game {
  const state = new Game().state();
  state.units = units;
  state.centers = {};
  return Game.fromState(state);
}

/** France takes Munich from Burgundy while Berlin and Warsaw bounce in Silesia. */
function munichDislodged(): Game {
  const game = board({
    GERMANY: ["A MUN", "A BER"],
    FRANCE: ["A BUR", "A RUH"],
    RUSSIA: ["A WAR"],
  });
  game.process({
    orders: {
      FRANCE: ["A BUR - MUN", "A RUH S A BUR - MUN"],
      GERMANY: ["A BER - SIL"],
      RUSSIA: ["A WAR - SIL"],
    },
  });
  expect(game.phase()).toBe("S1901R");
  return game;
}

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../crates/cabal-engine/tests/data/games/${name}`, import.meta.url),
    ),
    "utf8",
  );

describe("past phases", () => {
  it("reports the state and status that followed each phase, not the present", () => {
    const game = new Game();
    game.process({ orders: { FRANCE: ["A PAR - BUR"] } });
    game.process({ orders: { FRANCE: ["A BUR - BEL"] } });
    expect(game.phase()).toBe("W1901A");
    const first = game.outcome(0);
    expect(first.phase).toBe("S1901M");
    expect(first.next.name).toBe("F1901M");
    expect(first.next.units["FRANCE"]).toContain("A BUR");
    expect(first.status).toBe("active");
    const second = game.outcome(1);
    expect(second.next.name).toBe("W1901A");
    expect(second.next.units["FRANCE"]).toContain("A BEL");
    expect(second.next.builds["FRANCE"]?.count).toBe(1);
  });

  it("gives only the last phase of a finished game its ending", () => {
    const game = new Game();
    game.process({ orders: {} });
    game.process({ orders: {} });
    game.declareDraw(["FRANCE", "ITALY"]);
    expect(game.status()).toBe("draw");
    expect(game.drawMembers()).toEqual(["FRANCE", "ITALY"]);
    expect(game.outcome(0).status).toBe("active");
    expect(game.outcome(1).status).toBe("draw");
  });

  it("lists retreat options of a past phase from the state that followed it", () => {
    const game = munichDislodged();
    game.process({ orders: { GERMANY: ["A MUN R TYR"] } });
    game.process({ orders: {} });
    const past = game.outcome(0);
    expect(past.next.name).toBe("S1901R");
    expect(past.standoffs).toEqual(["SIL"]);
    expect(past.dislodged).toEqual([
      { unit: "A MUN", attacker_from: "BUR", retreat_options: ["BOH", "KIE", "TYR"] },
    ]);
  });
});

describe("retreat states", () => {
  it("names the retreating unit in full", () => {
    const game = munichDislodged();
    const legal = game.legal("GERMANY");
    expect(Object.keys(legal.by_unit)).toEqual(["A MUN"]);
    expect(legal.by_unit["A MUN"]).toEqual([
      "A MUN D",
      "A MUN R BOH",
      "A MUN R KIE",
      "A MUN R TYR",
    ]);
    const outcome = game.process({ orders: { GERMANY: ["A MUN R TYR"] } });
    expect(outcome.results[0]).toMatchObject({ unit: "A MUN", order: "A MUN R TYR", ok: true });
  });

  it("keeps the attacker's origin and standoffs through state and fromState", () => {
    const game = munichDislodged();
    const state = game.state();
    expect(state.retreats["GERMANY"]).toEqual({ "A MUN": ["BOH", "KIE", "TYR"] });
    expect(state.cabal).toEqual({
      dislodged: [{ unit: "A MUN", attacker_from: "BUR", by_convoy: false }],
      standoffs: ["SIL"],
    });
    const options = (s: State) => Game.fromState(s).legal("GERMANY").by_unit["A MUN"];
    expect(options(state)).toEqual(game.legal("GERMANY").by_unit["A MUN"]);

    // a state that crossed a boundary which strips unknown keys (the wire
    // schema does) still offers exactly the recorded retreats
    const { cabal: _dropped, ...stripped } = state;
    expect(options(stripped)).toEqual(game.legal("GERMANY").by_unit["A MUN"]);
    expect(options(JSON.parse(JSON.stringify(stripped)) as State)).not.toContain("A MUN R BUR");
    expect(options(stripped)).not.toContain("A MUN R SIL");
  });

  it("previews a retreat phase with the right restrictions", () => {
    const state = munichDislodged().state();
    const illegal = preview(state, { orders: { GERMANY: ["A MUN R BUR"] } });
    expect(illegal.results[0]).toMatchObject({ ok: false, code: "illegal" });
    const legal = preview(state, { orders: { GERMANY: ["A MUN R BOH"] } });
    expect(legal.results[0]?.ok).toBe(true);
    expect(legal.next.units["GERMANY"]).toContain("A BOH");
  });
});

describe("saved games", () => {
  it("records the rulebook, outcome and engine version, and restores them", () => {
    const game = new Game("1971");
    game.process({ orders: { ENGLAND: ["F LON - NTH"] } });
    game.declareDraw();
    const json = game.toSaved("g1");
    const saved = JSON.parse(json) as {
      rules: string[];
      phases: { name: string }[];
      cabal: { engine: string; rulebook: { edition: string }; outcome: { result: string; members: string[] } };
    };
    expect(saved.rules).toEqual(["1971"]);
    expect(saved.phases.at(-1)?.name).toBe("COMPLETED");
    expect(saved.cabal.engine).toBe(version());
    expect(saved.cabal.rulebook.edition).toBe("e1971");
    expect(saved.cabal.outcome.result).toBe("draw");
    expect(saved.cabal.outcome.members).toHaveLength(7);

    // the file's rulebook wins over the argument, and the draw survives
    for (const restored of [Game.fromSaved(json, "2023"), Game.resume(json, "2023")]) {
      expect(restored.status()).toBe("draw");
      expect(restored.rulebook()).toBe("1971");
      expect(restored.phase()).toBe("COMPLETED");
      expect(restored.toSaved("g1")).toBe(json);
    }
  });

  it("still loads a file written before the cabal block existed", () => {
    const game = new Game();
    game.process({ orders: { ENGLAND: ["F LON - NTH"] } });
    const legacy = JSON.parse(game.toSaved("old")) as Record<string, unknown>;
    delete legacy["cabal"];
    legacy["rules"] = ["E2023"];
    const json = JSON.stringify(legacy);
    expect(Game.fromSaved(json).phase()).toBe("F1901M");
    expect(Game.resume(json).phase()).toBe("F1901M");
    expect(verifySaved(json).divergences).toEqual([]);
  });

  it("saves press and pledges with the game", () => {
    const game = new Game();
    game.recordMessage({
      sender: "FRANCE",
      recipient: "GERMANY",
      time_sent: 1,
      message: "Burgundy stays empty.",
    });
    const orders = game.pledgeCheck("FRANCE", ["par - pic"]);
    expect(orders).toEqual(["A PAR - PIC"]);
    game.recordPledge({
      id: "p1",
      phase: game.phase(),
      pledger: "FRANCE",
      audience: "GERMANY",
      sealed: true,
      orders,
    });
    const submitted = ["A PAR - BUR"];
    game.process({ orders: { FRANCE: submitted } });
    const receipt = game.pledgeReceipt(0, "FRANCE", orders, submitted);
    expect(receipt).toBe("broken");
    game.recordPledge({
      id: "p1",
      phase: "S1901M",
      pledger: "FRANCE",
      audience: "GERMANY",
      sealed: true,
      orders,
      receipt,
    });
    const json = game.toSaved("press");
    const saved = JSON.parse(json) as {
      phases: { messages: { phase: string; message: string }[] }[];
      cabal: { pledges: { id: string; receipt: string }[] };
    };
    expect(saved.phases[0]?.messages).toEqual([
      { sender: "FRANCE", recipient: "GERMANY", phase: "S1901M", time_sent: 1, message: "Burgundy stays empty." },
    ]);
    expect(saved.cabal.pledges).toEqual([expect.objectContaining({ id: "p1", receipt: "broken" })]);
    expect(Game.fromSaved(json).toSaved("press")).toBe(json);
    expect(Game.resume(json).toSaved("press")).toBe(json);
  });
});

describe("restoring without replaying", () => {
  it("resumes a game with its history intact and plays on identically", () => {
    const live = munichDislodged();
    live.process({ orders: { GERMANY: ["A MUN R BOH"] } });
    const json = live.toSaved("r1");
    const resumed = Game.resume(json);
    expect(resumed.phase()).toBe(live.phase());
    expect(resumed.state()).toEqual(live.state());
    expect(resumed.historyLength()).toBe(2);
    // archived phases are still inspectable
    expect(resumed.outcome(0)).toEqual(live.outcome(0));
    expect(resumed.outcome(1)).toEqual(live.outcome(1));
    expect(resumed.explain(0).dot).toBe(live.explain(0).dot);
    const orders = { orders: { FRANCE: ["A MUN - TYR"], GERMANY: ["A BOH - MUN"] } };
    expect(resumed.process(orders)).toEqual(live.process(orders));
    expect(resumed.toSaved("r1")).toBe(live.toSaved("r1"));
  });

  it("restores a retreat phase from a snapshot, alone or with the save as history", () => {
    const live = munichDislodged();
    const snapshot = live.snapshot();
    expect(snapshot.length).toBeLessThan(2500);
    const alone = Game.fromSnapshot(snapshot);
    expect(alone.state()).toEqual(live.state());
    expect(alone.historyLength()).toBe(0);
    const full = Game.fromSnapshot(snapshot, live.toSaved("s1"));
    expect(full.state()).toEqual(live.state());
    expect(full.historyLength()).toBe(1);
    expect(full.toSaved("s1")).toBe(live.toSaved("s1"));
  });

  it("replays only the tail recorded after the snapshot", () => {
    const live = new Game();
    live.process({ orders: { FRANCE: ["A PAR - BUR"] } });
    const snapshot = live.snapshot();
    live.process({ orders: { FRANCE: ["A BUR - BEL"] } });
    const restored = Game.fromSnapshot(snapshot, live.toSaved("t1"));
    expect(restored.phase()).toBe("W1901A");
    expect(restored.toSaved("t1")).toBe(live.toSaved("t1"));
    expect(() => Game.fromSnapshot('{"format":99}')).toThrow();
  });

  it("does not brick on a record made under an older ruling", () => {
    // Recorded before the standoff fix: Munich and Vienna bounced in Tyrolia,
    // both were dislodged, and Munich was allowed to retreat there.
    const game = board({
      GERMANY: ["A MUN"],
      AUSTRIA: ["A VIE"],
      FRANCE: ["A BUR", "A RUH"],
      RUSSIA: ["A GAL", "A BUD"],
    });
    const spring = game.process({
      orders: {
        GERMANY: ["A MUN - TYR"],
        AUSTRIA: ["A VIE - TYR"],
        FRANCE: ["A BUR - MUN", "A RUH S A BUR - MUN"],
        RUSSIA: ["A GAL - VIE", "A BUD S A GAL - VIE"],
      },
    });
    expect(spring.standoffs).toEqual(["TYR"]);
    expect(game.legal("GERMANY").by_unit["A MUN"]).not.toContain("A MUN R TYR");
    game.process({ orders: { GERMANY: ["A MUN R BOH"] } });

    type Phase = {
      state: { cabal?: unknown; units: Record<string, string[]>; retreats: Record<string, Record<string, string[]>> };
      orders: Record<string, string[]>;
    };
    const old = JSON.parse(game.toSaved("old")) as { cabal?: unknown; rules: string[]; phases: Phase[] };
    delete old.cabal;
    old.rules = ["E2023"];
    for (const phase of old.phases) delete phase.state.cabal;
    old.phases[1]!.state.retreats["GERMANY"]!["A MUN"]!.push("TYR");
    old.phases[1]!.orders["GERMANY"] = ["MUN R TYR"];
    old.phases[2]!.state.units["GERMANY"] = ["A TYR"];
    const json = JSON.stringify(old);

    expect(() => Game.fromSaved(json)).toThrow(/diverged/);
    const report = verifySaved(json);
    expect(report.strict).toBe(false);
    expect(report.divergences.map((d) => d.field)).toEqual(expect.arrayContaining(["retreats", "units"]));
    expect(report.divergences.find((d) => d.field === "units")).toMatchObject({
      phase: "S1901R",
      subject: "GERMANY",
      expected: "A TYR",
      got: "",
    });

    const resumed = Game.resume(json);
    expect(resumed.state().units["GERMANY"]).toEqual(["A TYR"]);
    expect(resumed.historyLength()).toBe(2);
    const next = resumed.process({ orders: { GERMANY: ["A TYR - PIE"] } });
    expect(next.next.units["GERMANY"]).toEqual(["A PIE"]);
    const saved = JSON.parse(resumed.toSaved("old")) as { phases: unknown[] };
    expect(saved.phases.slice(0, 2)).toEqual(old.phases.slice(0, 2));
    expect(saved.phases).toHaveLength(4);
  });
});

describe("verifySaved", () => {
  it("replays the committed fixtures with zero divergences", () => {
    for (const name of ["generated/convoy_and_coasts.json", "generated/retreat_start.json"]) {
      const report = verifySaved(fixture(name));
      expect(report.divergences, name).toEqual([]);
      expect(report.strict).toBe(true);
      expect(report.recorded_by).toBe("0.1.0");
    }
    const cicero = verifySaved(fixture("external/cicero_433761.json"));
    expect(cicero).toMatchObject({ phases: 35, strict: false, rulebook: "1982", recorded_by: null });
    expect(cicero.divergences).toEqual([]);
  });

  it("names the phase, field and subject of a tampered record", () => {
    const saved = JSON.parse(fixture("generated/opening_1901.json")) as {
      phases: { results: Record<string, string[]>; state: { centers: Record<string, string[]> } }[];
    };
    saved.phases[0]!.results["A PAR"] = ["cut"];
    saved.phases[1]!.state.centers["FRANCE"]!.push("MUN");
    const report = verifySaved(JSON.stringify(saved));
    expect(report.divergences).toEqual(
      expect.arrayContaining([
        { phase: "S1901M", field: "results", subject: "A PAR", expected: "cut", got: "bounce" },
        expect.objectContaining({ phase: "S1901M", field: "centers", subject: "FRANCE" }),
      ]),
    );
    expect(() => verifySaved("{}")).toThrow();
  });
});

describe("pledges against the board", () => {
  it("rejects a pledge about a unit the pledger does not command", () => {
    const game = new Game();
    expect(() => game.pledgeCheck("FRANCE", ["A MUN - BUR"])).toThrow(/your own units/);
    expect(() => game.pledgeCheck("FRANCE", ["GER: A MUN - BUR"])).toThrow(/your own units/);
    expect(() => game.pledgeCheck("FRANCE", ["A BUR - MUN"])).toThrow(/no unit there/);
    expect(() => game.pledgeCheck("FRANCE", ["A PAR - MOS"])).toThrow(/not a legal order/);
    expect(() => game.pledgeCheck("FRANCE", [])).toThrow(/at least one order/);
    expect(game.pledgeCheck("FRANCE", ["a par - bur", "A PAR - BUR"])).toEqual(["A PAR - BUR"]);
  });

  it("calls silence from a power with units broken, not void", () => {
    const game = new Game();
    game.process({ orders: { GERMANY: ["A MUN - BUR"] } });
    expect(game.pledgeReceipt(0, "FRANCE", ["A PAR - BUR"], [])).toBe("broken");
    expect(game.pledgeReceipt(0, "FRANCE", ["A PAR - BUR"], ["par - bur", "F BRE - MAO"])).toBe("kept");
    expect(game.pledgeReceipt(0, "FRANCE", ["A PAR - BUR"], ["A PAR - PIC"])).toBe("broken");
    // a pledge that could never bind is void, and so is one from a power with nothing to order
    expect(game.pledgeReceipt(0, "FRANCE", ["A MUN - BUR"], ["A PAR - BUR"])).toBe("void");
    const lonely = board({ GERMANY: ["A MUN"] });
    lonely.process({ orders: {} });
    expect(lonely.pledgeReceipt(0, "FRANCE", ["A PAR - BUR"], [])).toBe("void");
    // the text-only helper cannot know about the board
    expect(pledgeReceipt(["A PAR - BUR"], [])).toBe("void");
    expect(() => game.pledgeReceipt(5, "FRANCE", [], [])).toThrow(/no such phase/);
  });
});

import { describe, expect, it } from "vitest";
import {
  type ComposeContext,
  type Draft,
  adjustmentsLeft,
  canGoByConvoy,
  carryingFleets,
  click,
  disbandSelected,
  holdSelected,
  nextWaiveKey,
  setMode,
  viaAlternative,
} from "./compose.js";
import { continueLabel, describePhase, forUnit, parseOrder, phaseKind, resolveLabel } from "./notation.js";

const movement: ComposeContext = {
  phase: "M",
  pieces: [
    { power: "FRANCE", unit: "A PAR", province: "PAR", dislodged: false },
    { power: "FRANCE", unit: "F BRE", province: "BRE", dislodged: false },
    { power: "ENGLAND", unit: "F ENG", province: "ENG", dislodged: false },
    { power: "ENGLAND", unit: "A LON", province: "LON", dislodged: false },
    { power: "FRANCE", unit: "F MAO", province: "MAO", dislodged: false },
  ],
  legal: {
    FRANCE: {
      "A PAR": ["A PAR H", "A PAR - BUR", "A PAR - PIC", "A PAR S F BRE", "A PAR S A LON - PIC"],
      "F BRE": ["F BRE H", "F BRE - PIC", "F BRE - ENG"],
      "F MAO": ["F MAO H", "F MAO - SPA/NC", "F MAO - SPA/SC", "F MAO C A LON - BRE"],
    },
    ENGLAND: {
      "F ENG": ["F ENG H", "F ENG - PIC"],
      "A LON": ["A LON H", "A LON - BRE VIA", "A LON - WAL"],
    },
  },
};

const start: Draft = { step: "idle" };

describe("movement orders", () => {
  it("selects a unit, then moves it", () => {
    const s1 = click(movement, start, "PAR");
    expect(s1.draft).toEqual({ step: "unit", power: "FRANCE", unit: "A PAR" });
    const s2 = click(movement, s1.draft, "BUR");
    expect(s2.effect).toEqual({ kind: "order", power: "FRANCE", key: "A PAR", text: "A PAR - BUR" });
    expect(s2.draft.step).toBe("idle");
  });

  it("holds when the same province is clicked twice", () => {
    const s1 = click(movement, start, "PAR");
    expect(click(movement, s1.draft, "PAR").effect).toMatchObject({ text: "A PAR H" });
  });

  it("switches selection when another unit is clicked instead of a destination", () => {
    const s1 = click(movement, start, "PAR");
    expect(click(movement, s1.draft, "ENG").draft).toEqual({ step: "unit", power: "ENGLAND", unit: "F ENG" });
  });

  it("explains an unreachable destination", () => {
    const s1 = click(movement, start, "PAR");
    expect(click(movement, s1.draft, "MUN").effect).toEqual({ kind: "message", text: "A PAR cannot move to MUN." });
  });

  it("asks which coast when a fleet can reach two", () => {
    const s1 = click(movement, start, "MAO");
    const s2 = click(movement, s1.draft, "SPA");
    expect(s2.effect).toMatchObject({ kind: "choose", key: "F MAO", options: ["F MAO - SPA/NC", "F MAO - SPA/SC"] });
  });

  it("uses a convoy route when that is the only way", () => {
    const s1 = click(movement, start, "LON");
    expect(click(movement, s1.draft, "BRE").effect).toMatchObject({ text: "A LON - BRE VIA" });
  });

  describe("choosing the convoy route first (V)", () => {
    const both: ComposeContext = {
      ...movement,
      legal: {
        ...movement.legal,
        ENGLAND: { ...movement.legal.ENGLAND, "A LON": ["A LON H", "A LON - BRE", "A LON - BRE VIA", "A LON - WAL"] },
      },
    };

    it("lets the player choose the convoy route when a direct route also exists", () => {
      const selected = click(both, start, "LON").draft;
      const via = setMode(both, selected, "via-convoy").draft;
      expect(via).toEqual({ step: "unit", power: "ENGLAND", unit: "A LON", via: true });
      expect(click(both, via, "BRE").effect).toMatchObject({ text: "A LON - BRE VIA" });
      expect(setMode(both, via, "move").draft).toEqual({ step: "unit", power: "ENGLAND", unit: "A LON" });
    });

    it("goes back to the land route when V is pressed again", () => {
      const via = setMode(both, click(both, start, "LON").draft, "via-convoy").draft;
      expect(setMode(both, via, "via-convoy").draft).toEqual({ step: "unit", power: "ENGLAND", unit: "A LON" });
    });

    it("explains a destination no fleet can reach, and keeps the convoy route chosen", () => {
      const via = setMode(both, click(both, start, "LON").draft, "via-convoy").draft;
      const step = click(both, via, "WAL");
      expect(step.effect).toEqual({
        kind: "message",
        text: "No fleet can carry A LON to WAL. Switch off By convoy to go by land.",
      });
      expect(step.draft).toEqual(via);
    });

    it("refuses the convoy route for a unit no fleet could carry", () => {
      const selected = click(movement, start, "PAR").draft;
      expect(setMode(movement, selected, "via-convoy").effect).toEqual({
        kind: "message",
        text: "No fleet is placed to carry A PAR anywhere.",
      });
      expect(canGoByConvoy(movement, "FRANCE", "A PAR")).toBe(false);
      expect(canGoByConvoy(movement, "ENGLAND", "A LON")).toBe(true);
    });

    it("drops the convoy route when another unit is selected", () => {
      const via = setMode(both, click(both, start, "LON").draft, "via-convoy").draft;
      expect(click(both, via, "PAR").draft).toEqual({ step: "unit", power: "FRANCE", unit: "A PAR" });
    });
  });

  describe("the fleets that carry a convoyed move", () => {
    it("lists every fleet that could convoy the army there, of any power, and which are ordered", () => {
      const ctx: ComposeContext = {
        ...movement,
        legal: {
          ...movement.legal,
          ENGLAND: { ...movement.legal.ENGLAND, "F ENG": ["F ENG H", "F ENG C A LON - BRE"] },
        },
        orders: { ENGLAND: { "F ENG": "F ENG C A LON - BRE" } },
      };
      expect(carryingFleets(ctx, "A LON - BRE VIA")).toEqual([
        { power: "ENGLAND", unit: "F ENG", order: "F ENG C A LON - BRE", given: true },
        { power: "FRANCE", unit: "F MAO", order: "F MAO C A LON - BRE", given: false },
      ]);
    });

    it("is empty for a move by land or any other order", () => {
      expect(carryingFleets(movement, "A LON - WAL")).toEqual([]);
      expect(carryingFleets(movement, "F MAO C A LON - BRE")).toEqual([]);
    });
  });

  it("composes a support for a foreign move", () => {
    const s1 = click(movement, start, "PAR");
    const s2 = setMode(movement, s1.draft, "support");
    expect(s2.draft.step).toBe("support");
    const s3 = click(movement, s2.draft, "LON");
    expect(s3.draft).toMatchObject({ step: "support", target: "A LON" });
    expect(click(movement, s3.draft, "PIC").effect).toMatchObject({ text: "A PAR S A LON - PIC" });
  });

  it("composes a support to hold by clicking the supported unit twice", () => {
    let d = setMode(movement, click(movement, start, "PAR").draft, "support").draft;
    d = click(movement, d, "BRE").draft;
    expect(click(movement, d, "BRE").effect).toMatchObject({ text: "A PAR S F BRE" });
  });

  it("rejects supports the engine did not list", () => {
    let d = setMode(movement, click(movement, start, "PAR").draft, "support").draft;
    d = click(movement, d, "LON").draft;
    expect(click(movement, d, "WAL").effect).toEqual({ kind: "message", text: "A PAR S A LON - WAL is not a legal order." });
  });

  it("composes a convoy", () => {
    let d = setMode(movement, click(movement, start, "MAO").draft, "convoy").draft;
    d = click(movement, d, "LON").draft;
    expect(click(movement, d, "BRE").effect).toMatchObject({ text: "F MAO C A LON - BRE" });
  });

  it("refuses convoy mode for a unit that cannot convoy", () => {
    const d = click(movement, start, "PAR").draft;
    expect(setMode(movement, d, "convoy").effect).toEqual({ kind: "message", text: "Only a fleet at sea can convoy." });
  });

  it("holds the selected unit from the keyboard", () => {
    const d = click(movement, start, "BRE").draft;
    expect(holdSelected(movement, d).effect).toMatchObject({ text: "F BRE H" });
  });
});

describe("retreats", () => {
  const retreat: ComposeContext = {
    phase: "R",
    pieces: [
      { power: "AUSTRIA", unit: "A BUD", province: "BUD", dislodged: false },
      { power: "ITALY", unit: "A BUD", province: "BUD", dislodged: true },
    ],
    legal: { ITALY: { "A BUD": ["A BUD D", "A BUD R GAL", "A BUD R RUM"] } },
  };

  it("retreats a dislodged unit and disbands from the keyboard", () => {
    const d = click(retreat, start, "BUD").draft;
    expect(d).toEqual({ step: "unit", power: "ITALY", unit: "A BUD" });
    expect(click(retreat, d, "GAL").effect).toMatchObject({ text: "A BUD R GAL" });
    expect(disbandSelected(retreat, d).effect).toMatchObject({ text: "A BUD D" });
  });
});

describe("adjustments", () => {
  const adjust: ComposeContext = {
    phase: "A",
    pieces: [{ power: "RUSSIA", unit: "A MOS", province: "MOS", dislodged: false }],
    legal: {
      RUSSIA: { "": ["A STP B", "F STP/NC B", "F STP/SC B", "WAIVE"] },
      TURKEY: { "": ["A SMY D", "F ANK D"] },
    },
  };

  it("offers every build in a home centre", () => {
    expect(click(adjust, start, "STP").effect).toMatchObject({
      kind: "choose",
      power: "RUSSIA",
      key: "B:STP",
      options: ["A STP B", "F STP/NC B", "F STP/SC B"],
    });
  });

  it("disbands with one click", () => {
    expect(click(adjust, start, "ANK").effect).toMatchObject({ power: "TURKEY", key: "D:ANK", text: "F ANK D" });
  });
});

describe("notation", () => {
  it("parses every order shape", () => {
    expect(parseOrder("A PAR S A BUR - PIC")).toMatchObject({ type: "support-move", dest: "PIC" });
    expect(parseOrder("F NTH C A LON - BRE")).toMatchObject({ type: "convoy", dest: "BRE" });
    expect(parseOrder("A LON - BRE VIA")).toMatchObject({ type: "move", via: true });
    expect(parseOrder("F STP/NC B")).toMatchObject({ type: "build", unit: { province: "STP", region: "STP/NC" } });
    expect(parseOrder("WAIVE")).toEqual({ type: "waive" });
    expect(parseOrder("nonsense")).toBeNull();
  });

  it("describes phases", () => {
    expect(describePhase("F1903R")).toEqual({ season: "Fall", year: "1903", kind: "Retreats" });
    expect(phaseKind("W1901A")).toBe("A");
  });
});

const idle: Draft = { step: "idle" };

describe("via convoy", () => {
  const both: ComposeContext = {
    phase: "M",
    pieces: [{ power: "ENGLAND", unit: "A WAL", province: "WAL", dislodged: false }],
    legal: { ENGLAND: { "A WAL": ["A WAL H", "A WAL - LON", "A WAL - LON VIA", "A WAL - BRE VIA"] } },
  };

  it("gives the land route when both exist and offers the convoy as an alternative", () => {
    const step = click(both, { step: "unit", power: "ENGLAND", unit: "A WAL" }, "LON");
    expect(step.effect).toEqual({ kind: "order", power: "ENGLAND", key: "A WAL", text: "A WAL - LON" });
    expect(viaAlternative(both, "ENGLAND", "A WAL - LON")).toBe("A WAL - LON VIA");
    expect(viaAlternative(both, "ENGLAND", "A WAL - LON VIA")).toBe("A WAL - LON");
  });

  it("offers no switch when only one route exists or the order is not a move", () => {
    expect(viaAlternative(both, "ENGLAND", "A WAL - BRE VIA")).toBeNull();
    expect(viaAlternative(both, "ENGLAND", "A WAL H")).toBeNull();
    expect(viaAlternative(both, "FRANCE", "A WAL - LON")).toBeNull();
  });
});

describe("adjustments", () => {
  const winter = (extra: Partial<ComposeContext> = {}): ComposeContext => ({
    phase: "A",
    pieces: [],
    legal: {
      FRANCE: { "": ["A MAR B", "F MAR B", "A PAR B", "WAIVE"] },
      AUSTRIA: { "": ["A VIE D", "A BUD D", "F ALB D"] },
    },
    allowance: { FRANCE: 1, AUSTRIA: -1 },
    orders: {},
    ...extra,
  });

  it("refuses a build beyond the allowance and says why", () => {
    const ctx = winter({ orders: { FRANCE: { "B:PAR": "A PAR B" } } });
    const step = click(ctx, idle, "MAR");
    expect(step.effect).toEqual({
      kind: "message",
      text: "France may only build 1 unit. Remove an order to choose a different one.",
    });
    expect(adjustmentsLeft(ctx, "FRANCE")).toBe(0);
  });

  it("still lets the player change the order already written for a province", () => {
    const ctx = winter({ orders: { FRANCE: { "B:MAR": "A MAR B" } } });
    const step = click(ctx, idle, "MAR");
    expect(step.effect).toMatchObject({ kind: "choose", key: "B:MAR", title: "Build in MAR" });
  });

  it("refuses a disband beyond what is owed", () => {
    const ctx = winter({ orders: { AUSTRIA: { "D:VIE": "A VIE D" } } });
    expect(click(ctx, idle, "BUD").effect).toEqual({
      kind: "message",
      text: "Austria only has to disband 1 unit. Remove an order to choose a different one.",
    });
    expect(click(winter(), idle, "BUD").effect).toEqual({ kind: "order", power: "AUSTRIA", key: "D:BUD", text: "A BUD D" });
  });

  it("counts a waive against the builds", () => {
    const ctx = winter({ orders: { FRANCE: { "WAIVE:0": "WAIVE" } } });
    expect(click(ctx, idle, "PAR").effect.kind).toBe("message");
  });

  it("acts for the active power when two powers could act in the same province", () => {
    const ctx = winter({
      legal: { AUSTRIA: { "": ["A TRI D"] }, ITALY: { "": ["A TRI B", "F TRI B"] } },
      allowance: { AUSTRIA: -1, ITALY: 1 },
    });
    expect(click({ ...ctx, active: "ITALY" }, idle, "TRI").effect).toMatchObject({ power: "ITALY", title: "Build in TRI" });
    expect(click({ ...ctx, active: "AUSTRIA" }, idle, "TRI").effect).toMatchObject({ power: "AUSTRIA", key: "D:TRI" });
    // Nobody active here: fall back to whoever can act.
    expect(click({ ...ctx, active: "FRANCE" }, idle, "TRI").effect).toMatchObject({ power: "AUSTRIA" });
  });

  it("titles a disband choice as a disband", () => {
    const ctx = winter({ legal: { RUSSIA: { "": ["F STP/NC D", "F STP/SC D"] } }, allowance: { RUSSIA: -1 } });
    expect(click(ctx, idle, "STP").effect).toMatchObject({ kind: "choose", title: "Disband in STP" });
  });
});

describe("nextWaiveKey", () => {
  it("never reuses a key that is still in the book", () => {
    expect(nextWaiveKey({})).toBe("WAIVE:0");
    expect(nextWaiveKey({ "WAIVE:0": "WAIVE", "B:PAR": "A PAR B" })).toBe("WAIVE:1");
    // The first waive was removed while the second stayed: the next one must not overwrite it.
    expect(nextWaiveKey({ "WAIVE:1": "WAIVE" })).toBe("WAIVE:0");
    expect(nextWaiveKey({ "WAIVE:0": "WAIVE", "WAIVE:1": "WAIVE" })).toBe("WAIVE:2");
  });
});

describe("phase buttons", () => {
  it("names the kind of phase being resolved", () => {
    expect(resolveLabel("S1901M")).toBe("Adjudicate Spring 1901");
    expect(resolveLabel("F1901R")).toBe("Resolve Fall 1901 retreats");
    expect(resolveLabel("W1901A")).toBe("Resolve Winter 1901 builds");
  });

  it("names the phase that comes next, never the one just shown", () => {
    expect(continueLabel("F1901M")).toBe("Continue to Fall 1901");
    expect(continueLabel("F1901R")).toBe("Continue to Fall 1901 retreats");
    expect(continueLabel("W1901A")).toBe("Continue to Winter 1901 builds");
    expect(continueLabel("COMPLETED")).toBe("See the final position");
  });
});

describe("forUnit", () => {
  it("puts the right unit on the front of an order written with another kind", () => {
    expect(forUnit("A TRI R ALB", "F TRI")).toBe("F TRI R ALB");
    expect(forUnit("A TRI D", "F TRI")).toBe("F TRI D");
    expect(forUnit("A STP R FIN", "F STP/SC")).toBe("F STP/SC R FIN");
  });

  it("leaves a correct order, and an order for somewhere else, alone", () => {
    expect(forUnit("F TRI R ALB", "F TRI")).toBe("F TRI R ALB");
    expect(forUnit("A VIE R BOH", "F TRI")).toBe("A VIE R BOH");
    expect(forUnit("WAIVE", "F TRI")).toBe("WAIVE");
  });
});

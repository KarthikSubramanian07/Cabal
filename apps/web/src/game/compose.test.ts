import { describe, expect, it } from "vitest";
import { type ComposeContext, type Draft, click, disbandSelected, holdSelected, setMode } from "./compose.js";
import { describePhase, parseOrder, phaseKind } from "./notation.js";

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

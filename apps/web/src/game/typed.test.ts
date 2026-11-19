import { describe, expect, it } from "vitest";
import { type Verdict, normaliseTyped, routeTyped, splitTyped, suggest } from "./typed.js";

describe("normaliseTyped", () => {
  it("writes what players type the way orders are written", () => {
    expect(normaliseTyped("  a par ->  bur ")).toBe("A PAR - BUR");
    expect(normaliseTyped("f bre supports a par to pic")).toBe("F BRE S A PAR - PIC");
    expect(normaliseTyped("Fleet NTH convoys army LON → NWY")).toBe("F NTH C A LON - NWY");
    expect(normaliseTyped("a par-bur")).toBe("A PAR - BUR");
    expect(normaliseTyped("f stp/sc - bot")).toBe("F STP/SC - BOT");
  });
});

describe("splitTyped", () => {
  it("reads several orders separated by semicolons, commas or lines", () => {
    expect(splitTyped("A PAR - BUR; F BRE - MAO\nA MAR H, ")).toEqual(["A PAR - BUR", "F BRE - MAO", "A MAR H"]);
    expect(splitTyped("  ")).toEqual([]);
  });
});

describe("suggest", () => {
  const legal = [
    { power: "FRANCE", text: "A PAR H" },
    { power: "FRANCE", text: "A PAR - BUR" },
    { power: "FRANCE", text: "A PAR - PIC" },
    { power: "FRANCE", text: "F BRE S A PAR - PIC" },
    { power: "GERMANY", text: "A MUN - BUR" },
    { power: "ENGLAND", text: "F LON - ENG" },
  ];

  it("puts orders that start with the text first", () => {
    expect(suggest("a par", legal, "FRANCE").map((s) => s.text)).toEqual([
      "A PAR H",
      "A PAR - BUR",
      "A PAR - PIC",
      "F BRE S A PAR - PIC",
    ]);
  });

  it("matches words in order, so a province pair is enough", () => {
    expect(suggest("par pic", legal, "FRANCE").map((s) => s.text)).toEqual(["A PAR - PIC", "F BRE S A PAR - PIC"]);
  });

  it("prefers the active power's orders among equals", () => {
    expect(suggest("bur", legal, "GERMANY").map((s) => s.text)).toEqual(["A MUN - BUR", "A PAR - BUR"]);
    expect(suggest("bur", legal, "FRANCE").map((s) => s.text)).toEqual(["A PAR - BUR", "A MUN - BUR"]);
  });

  it("suggests nothing for nothing, and stops at the limit", () => {
    expect(suggest("   ", legal, "FRANCE")).toEqual([]);
    expect(suggest("a", legal, "FRANCE", 2)).toHaveLength(2);
    expect(suggest("zzz", legal, "FRANCE")).toEqual([]);
  });
});

describe("routeTyped", () => {
  const verdicts: Record<string, Verdict> = {
    FRANCE: { canonical: "F LON - BEL", legal: false, code: "foreign_unit", reason: "That unit belongs to another power." },
    ENGLAND: { canonical: "F LON - BEL", legal: false, code: "unreachable", reason: "The destination is not adjacent." },
    GERMANY: { canonical: "F LON - BEL", legal: false, code: "foreign_unit", reason: "That unit belongs to another power." },
  };
  const powers = ["ENGLAND", "FRANCE", "GERMANY"];

  it("gives the order to the first power it is legal for, the active one first", () => {
    const ok: Verdict = { canonical: "F LON - ENG", legal: true, code: "ok", reason: "The order is legal." };
    const judge = (p: string) => (p === "ENGLAND" ? ok : verdicts[p]!);
    expect(routeTyped(judge, "FRANCE", powers)).toEqual({ power: "ENGLAND", verdict: ok });
  });

  it("explains an illegal order with the owner's reason, not who owns the unit", () => {
    expect(routeTyped((p) => verdicts[p]!, "FRANCE", powers)).toEqual({ power: "ENGLAND", verdict: verdicts.ENGLAND });
  });

  it("falls back to the active power when nobody could give the order", () => {
    const bad: Verdict = { canonical: null, legal: false, code: "unparseable", reason: "The order could not be read." };
    expect(routeTyped(() => bad, "GERMANY", powers).power).toBe("GERMANY");
  });
});

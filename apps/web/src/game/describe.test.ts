import { describe, expect, it } from "vitest";
import type { PhaseOutcome, State } from "../engine.js";
import type { ComposeContext, Draft } from "./compose.js";
import { choicePrompt, choicesFor, describeBoard, describeOutcome, phaseLine, statusLine } from "./describe.js";

const names = {
  PAR: { name: "Paris" },
  BUR: { name: "Burgundy" },
  PIC: { name: "Picardy" },
  BRE: { name: "Brest" },
  LON: { name: "London" },
};

const ctx: ComposeContext = {
  phase: "M",
  pieces: [
    { power: "FRANCE", unit: "A PAR", province: "PAR", dislodged: false },
    { power: "FRANCE", unit: "F BRE", province: "BRE", dislodged: false },
    { power: "ENGLAND", unit: "A LON", province: "LON", dislodged: false },
  ],
  legal: {
    FRANCE: {
      "A PAR": ["A PAR H", "A PAR - BUR", "A PAR - PIC", "A PAR S F BRE"],
      "F BRE": ["F BRE H", "F BRE - PIC"],
    },
  },
};

describe("keyboard choices", () => {
  it("offers the active power's units when nothing is selected", () => {
    const idle: Draft = { step: "idle" };
    expect(choicesFor(ctx, idle, "FRANCE", ["A PAR", "F BRE"], new Set(), names)).toEqual([
      { code: "PAR", label: "A PAR: Army Paris" },
      { code: "BRE", label: "F BRE: Fleet Brest" },
    ]);
    expect(choicePrompt("M", idle, "FRANCE")).toBe("France: choose a unit to order");
  });

  it("offers the highlighted destinations, by name, once a unit is selected", () => {
    const draft: Draft = { step: "unit", power: "FRANCE", unit: "A PAR" };
    expect(choicesFor(ctx, draft, "FRANCE", [], new Set(["PIC", "BUR"]), names)).toEqual([
      { code: "BUR", label: "Move to Burgundy (BUR)" },
      { code: "PIC", label: "Move to Picardy (PIC)" },
    ]);
    expect(choicePrompt("M", draft, "FRANCE")).toBe("A PAR: choose where it goes");
  });

  it("names the unit to support, then whether it holds or moves", () => {
    const pick: Draft = { step: "support", power: "FRANCE", unit: "A PAR" };
    expect(choicesFor(ctx, pick, "FRANCE", [], new Set(["BRE"]), names)).toEqual([
      { code: "BRE", label: "Support F BRE: Fleet Brest" },
    ]);
    const how: Draft = { step: "support", power: "FRANCE", unit: "A PAR", target: "F BRE" };
    expect(choicesFor(ctx, how, "FRANCE", [], new Set(["BRE", "PIC"]), names).map((c) => c.label)).toEqual([
      "Support F BRE holding",
      "Support F BRE into Picardy (PIC)",
    ]);
  });

  it("lists builds and disbands in adjustment phases", () => {
    const winter: ComposeContext = {
      phase: "A",
      pieces: [],
      legal: { FRANCE: { "": ["A PAR B", "F BRE B", "A BRE B", "WAIVE"] } },
    };
    expect(choicesFor(winter, { step: "idle" }, "FRANCE", [], new Set(), names)).toEqual([
      { code: "PAR", label: "Build in Paris (PAR)" },
      { code: "BRE", label: "Build in Brest (BRE)" },
    ]);
  });
});

describe("board as text", () => {
  it("lists every power's units and centres", () => {
    const state = {
      name: "S1901M",
      units: { FRANCE: ["A PAR", "*F BRE"] },
      centers: { FRANCE: ["PAR", "BRE"] },
      homes: { FRANCE: ["PAR", "BRE"] },
    } as unknown as State;
    expect(describeBoard(state, names)).toEqual([
      {
        power: "France",
        units: ["A PAR, Army Paris", "F BRE, Fleet Brest (dislodged)"],
        centers: ["Brest (BRE)", "Paris (PAR)"],
      },
    ]);
  });
});

describe("announcements", () => {
  it("summarises an adjudicated phase and names what comes next", () => {
    const outcome = {
      phase: "S1901M",
      results: [
        { power: "FRANCE", unit: "A PAR", order: "A PAR - BUR", ok: true, code: "ok", reason: "" },
        { power: "GERMANY", unit: "A MUN", order: "A MUN - BUR", ok: false, code: "bounce", reason: "" },
        { power: "ENGLAND", unit: "A LON", order: "A LON H", ok: true, code: "ok", reason: "" },
      ],
      dislodged: [],
      standoffs: ["BUR"],
      civil_disorder: [],
      next: { name: "F1901M" },
      status: "active",
    } as unknown as PhaseOutcome;
    expect(describeOutcome(outcome, new Set(["A PAR - BUR", "A MUN - BUR"]))).toBe(
      "Spring 1901 movement resolved. 1 order succeeded, 1 failed. Standoff in BUR. Next: Fall 1901 movement. The results are listed beside the board.",
    );
  });

  it("says who won when the game ends", () => {
    expect(statusLine("solo:FRANCE")).toBe("France wins outright.");
    expect(statusLine("draw")).toBe("The game ended in a draw.");
    expect(statusLine("active")).toBeNull();
    expect(phaseLine("W1901A")).toBe("Winter 1901 adjustments");
  });
});

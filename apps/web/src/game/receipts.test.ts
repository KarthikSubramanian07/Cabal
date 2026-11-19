import { describe, expect, it } from "vitest";
import type { OrderResult } from "../engine.js";
import { receiptFor, wordsFromCode } from "./receipts.js";

const names = { PAR: { name: "Paris" }, MUN: { name: "Munich" }, BUR: { name: "Burgundy" }, TYR: { name: "Tyrolia" } };

function result(reason: string, code = "illegal", ok = false): OrderResult {
  return { power: "FRANCE", unit: "A PAR", order: "A PAR - BUR", ok, code, reason };
}

/** Every reason string the engine can write (crates/cabal-engine/src/text.rs, crates/cabal-wasm/src/lib.rs). */
const MOVEMENT = [
  ["bounced with MUN", "bounce"],
  ["bounced with MUN, TYR", "bounce"],
  ["repelled by BUR", "bounce"],
  ["lost head-to-head with MUN", "bounce"],
  ["cannot dislodge own unit", "bounce"],
  ["no convoy path", "no_path"],
  ["dislodged by MUN", "dislodged"],
  ["support cut by MUN", "cut"],
  ["supporter dislodged by MUN", "dislodged"],
  ["support void (no matching order)", "void"],
  ["convoy dislodged by MUN", "dislodged"],
  ["convoy fails (paradox, Szykman rule)", "paradox"],
  ["convoy void (no matching move)", "void"],
] as const;

const ILLEGAL = {
  M: ["NoUnit", "ForeignUnit", "DuplicateOrder", "MoveToSelf", "Unreachable", "AmbiguousCoast", "SupportSelf", "SupportUnreachable", "SupportNoUnit", "ConvoyNotAtSea", "ConvoyNotArmy", "ConvoyNoRoute", "NotInPhase"],
  R: ["NotDislodged", "Unreachable", "AmbiguousCoast", "Occupied", "AttackerOrigin", "Standoff", "NotInPhase"],
  A: ["NothingToDo", "AllowanceUsed", "NotHomeCenter", "NotOwned", "Occupied", "BadTerrain", "NoUnit", "ForeignUnit", "NotInPhase"],
};

/** No enum names, no brackets, no debug punctuation: a sentence a player can read. */
function expectHuman(text: string) {
  expect(text).not.toMatch(/\(|\)/);
  expect(text).not.toMatch(/[a-z][A-Z]/);
  expect(text).not.toMatch(/illegal/i);
  expect(text).toMatch(/^[A-Z].*\.$/);
}

describe("receipts that look at the rest of the phase", () => {
  const move = (unit: string, dest: string, ok: boolean, reason: string): OrderResult => ({
    power: "X",
    unit,
    order: `${unit} - ${dest}`,
    ok,
    code: ok ? "ok" : "bounce",
    reason,
  });
  const support = (unit: string, target: string, dest: string, ok = true): OrderResult => ({
    power: "X",
    unit,
    order: `${unit} S ${target} - ${dest}`,
    ok,
    code: ok ? "ok" : "cut",
    reason: ok ? "" : "support cut by TYR",
  });

  it("does not say a unit held its ground when it tried to leave and bounced back", () => {
    // A BRE - PAR meets A PAR, which was ordered to Burgundy and bounced there with Munich.
    const attack = move("A BRE", "PAR", false, "repelled by PAR");
    const all = [attack, move("A PAR", "BUR", false, "bounced with MUN"), move("A MUN", "BUR", false, "bounced with PAR")];
    const detail = receiptFor(attack, "S1901M", names, all).detail;
    expect(detail).toBe("The unit in Paris failed to move out, and the attack was not strong enough to dislodge it.");
    expect(detail).not.toMatch(/held/);
  });

  it("says a unit stayed put when it was not ordered away", () => {
    const attack = move("A BRE", "PAR", false, "repelled by PAR");
    const hold: OrderResult = { power: "X", unit: "A PAR", order: "A PAR H", ok: true, code: "ok", reason: "" };
    expect(receiptFor(attack, "S1901M", names, [attack, hold]).detail).toBe(
      "The unit in Paris stayed put, and the attack was not strong enough to dislodge it.",
    );
    expect(receiptFor(attack, "S1901M", names).detail).toContain("stayed put");
  });

  it("tells a tie from losing to a stronger move", () => {
    const par = move("A PAR", "BUR", false, "bounced with MUN");
    const mun = move("A MUN", "BUR", false, "bounced with PAR");
    expect(receiptFor(par, "S1901M", names, [par, mun]).detail).toBe(
      "Bounced with the unit from Munich: equal strength, so nobody got in.",
    );
    // Three into Burgundy: Paris alone, Munich and Tyrolia each with one support.
    const tyr = move("A TYR", "BUR", false, "bounced with MUN");
    const lone = move("A PAR", "BUR", false, "bounced with MUN, TYR");
    const all = [lone, mun, tyr, support("A RUH", "A MUN", "BUR"), support("A PIE", "A TYR", "BUR")];
    expect(receiptFor(lone, "S1901M", names, all).detail).toBe(
      "Bounced by the units from Munich and Tyrolia, which had more support.",
    );
    // A cut support does not count.
    const cut = [par, mun, support("A RUH", "A MUN", "BUR", false)];
    expect(receiptFor(par, "S1901M", names, cut).detail).toContain("equal strength");
  });

  it("stays non-committal when the supports do not add up to an answer", () => {
    const par = move("A PAR", "BUR", false, "bounced with MUN");
    const mun = move("A MUN", "BUR", false, "bounced with PAR");
    // On this count Paris is the stronger, yet it bounced: a rule the tally does not know.
    const all = [par, mun, support("A GAS", "A PAR", "BUR")];
    expect(receiptFor(par, "S1901M", names, all).detail).toBe(
      "Bounced with the unit from Munich, which had at least as much strength.",
    );
  });
});

describe("receiptFor", () => {
  it("says nothing more about an order that worked", () => {
    expect(receiptFor(result("moves", "ok", true), "S1901M")).toEqual({ tone: "ok", verdict: "Succeeded", detail: "" });
  });

  it("explains every movement failure in a sentence", () => {
    for (const [reason, code] of MOVEMENT) {
      const r = receiptFor(result(reason, code), "S1901M", names);
      expect(r.tone, reason).toBe("fail");
      expect(r.verdict.length, reason).toBeGreaterThan(3);
      expectHuman(r.detail);
    }
  });

  it("uses place names when it has them and codes when it does not", () => {
    expect(receiptFor(result("bounced with MUN", "bounce"), "S1901M", names).detail).toBe(
      "Bounced with the unit from Munich, which had at least as much strength.",
    );
    expect(receiptFor(result("bounced with MUN, TYR", "bounce"), "S1901M", names).detail).toContain("Munich and Tyrolia");
    expect(receiptFor(result("bounced with MUN", "bounce"), "S1901M").detail).toContain("MUN");
  });

  it("never shows a raw engine code for an illegal order, in any phase", () => {
    for (const reason of ILLEGAL.M) {
      const r = receiptFor(result(`illegal (${reason}), holds`), "S1901M", names);
      expectHuman(r.detail);
      expect(r.detail).toContain("The unit held instead.");
    }
    const dislodged = receiptFor(result("illegal (Unreachable), holds, dislodged by MUN"), "S1901M", names);
    expectHuman(dislodged.detail);
    expect(dislodged.detail).toContain("dislodged by the attack from Munich");
    for (const reason of ILLEGAL.R) {
      const r = receiptFor(result(`illegal retreat (${reason}), disbanded`), "F1901R", names);
      expectHuman(r.detail);
      expect(r.detail).toContain("The unit was disbanded.");
    }
    for (const reason of ILLEGAL.A) {
      const r = receiptFor(result(`illegal (${reason})`), "W1901A", names);
      expectHuman(r.detail);
    }
    expect(receiptFor(result("illegal (AllowanceUsed)"), "W1901A").detail).toBe(
      "This power had already used every build or disband it was owed.",
    );
  });

  it("treats a disband the player ordered as neutral, not as a failure", () => {
    expect(receiptFor(result("disbanded", "disband"), "F1901R")).toEqual({
      tone: "neutral",
      verdict: "Disbanded",
      detail: "The unit was disbanded.",
    });
  });

  it("words a bounced retreat as a disband", () => {
    const r = receiptFor(result("bounced with TYR", "bounce"), "F1901R", names);
    expect(r.detail).toBe("Another retreat from Tyrolia was headed for the same province, so the unit was disbanded.");
  });

  it("falls back to readable words for a reason it has never seen", () => {
    const unknown = receiptFor(result("illegal (SomethingBrandNew), holds"), "S1901M");
    expectHuman(unknown.detail);
    expect(unknown.detail).toContain("something brand new");
    const odd = receiptFor(result("struck by lightning (ActOfGod)", "weird"), "S1901M");
    expect(odd.detail).toBe("Struck by lightning (act of god).");
  });
});

describe("wordsFromCode", () => {
  it("splits camel case and snake case", () => {
    expect(wordsFromCode("AllowanceUsed")).toBe("allowance used");
    expect(wordsFromCode("no_path")).toBe("no path");
  });
});

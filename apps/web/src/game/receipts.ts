/**
 * Receipts in plain words. The engine explains every order with a short code and a terse
 * reason written for logs (`illegal (AllowanceUsed)`, `bounced with PAR`). Players get a
 * sentence instead. Every code and reason the engine can produce is covered here; anything
 * new falls back to readable words, never to a raw enum name.
 */
import type { OrderResult } from "../engine.js";
import { type PhaseKind, phaseKind } from "./notation.js";

export interface Receipt {
  /** `ok` succeeded, `fail` did not, `neutral` is a disband the player asked for. */
  tone: "ok" | "fail" | "neutral";
  /** Two or three words for a stamp: `Bounced`, `Support cut`. */
  verdict: string;
  /** One sentence. Empty when the order simply worked. */
  detail: string;
}

type Names = Record<string, { name: string } | undefined>;

/** Why a movement order was not accepted (engine `Illegal`). */
const ILLEGAL_MOVE: Record<string, string> = {
  NoUnit: "There is no unit there to order.",
  ForeignUnit: "That unit belongs to another power.",
  DuplicateOrder: "The unit was given more than one order.",
  MoveToSelf: "A unit cannot move to the province it is already in.",
  Unreachable: "The unit cannot reach that province, even by convoy.",
  AmbiguousCoast: "Two coasts are in reach and the order did not name one.",
  SupportSelf: "A unit cannot support itself.",
  SupportUnreachable: "A unit can only support into a province it could move to.",
  SupportNoUnit: "There is no unit there to support.",
  ConvoyNotAtSea: "Only a fleet at sea can convoy.",
  ConvoyNotArmy: "Only armies can be convoyed.",
  ConvoyNoRoute: "The fleet is not on any route for that convoy.",
  NotInPhase: "That kind of order is not given in this phase.",
};

/** Why a retreat was not accepted (engine `RetreatIllegal`). */
const ILLEGAL_RETREAT: Record<string, string> = {
  NotDislodged: "The unit was not dislodged, so it has nothing to retreat from.",
  Unreachable: "The unit cannot reach that province.",
  AmbiguousCoast: "Two coasts are in reach and the order did not name one.",
  Occupied: "A unit is already standing there.",
  AttackerOrigin: "A unit cannot retreat to where its attacker came from.",
  Standoff: "Nobody may retreat into a province left empty by a standoff.",
  NotInPhase: "That kind of order is not given in this phase.",
};

/** Why a build or disband was not accepted (engine `AdjustIllegal`). */
const ILLEGAL_ADJUST: Record<string, string> = {
  NothingToDo: "This power has no builds or disbands to make this winter.",
  AllowanceUsed: "This power had already used every build or disband it was owed.",
  NotHomeCenter: "Units can only be built in a home supply centre.",
  NotOwned: "This power no longer owns that supply centre.",
  Occupied: "A unit is already standing there.",
  BadTerrain: "That kind of unit cannot be built there.",
  NoUnit: "There is no unit there to disband.",
  ForeignUnit: "That unit belongs to another power.",
  NotInPhase: "That kind of order is not given in this phase.",
};

/** `AllowanceUsed` -> `allowance used`: the last resort for a reason this file has not met. */
export function wordsFromCode(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function sentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const head = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

function place(names: Names | undefined, code: string): string {
  const c = code.trim();
  return names?.[c]?.name ?? c;
}

function places(names: Names | undefined, list: string): string {
  const all = list
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => place(names, c));
  if (all.length <= 1) return all[0] ?? "";
  return `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
}

function illegal(kind: PhaseKind, reason: string): string {
  const table = kind === "A" ? ILLEGAL_ADJUST : kind === "R" ? ILLEGAL_RETREAT : ILLEGAL_MOVE;
  return table[reason] ?? sentence(`Not a legal order: ${wordsFromCode(reason)}`);
}

/**
 * Turn one engine result into a receipt. `names` (the board's provinces) turns codes into
 * place names; without it the three-letter codes are kept.
 */
export function receiptFor(result: OrderResult, phase: string, names?: Names): Receipt {
  const kind = phaseKind(phase);
  const reason = result.reason.trim();
  if (result.ok) return { tone: "ok", verdict: "Succeeded", detail: "" };

  let m: RegExpExecArray | null;

  // Illegal orders, in each phase's own wording.
  if ((m = /^illegal retreat \((\w+)\)/.exec(reason))) {
    return { tone: "fail", verdict: "Not legal", detail: `${illegal("R", m[1]!)} The unit was disbanded.` };
  }
  if ((m = /^illegal \((\w+)\)(?:, holds)?(?:, dislodged by (\w+))?/.exec(reason))) {
    if (kind === "A") return { tone: "fail", verdict: "Not legal", detail: illegal("A", m[1]!) };
    const after = m[2]
      ? ` The unit held instead and was dislodged by the attack from ${place(names, m[2])}.`
      : " The unit held instead.";
    return { tone: "fail", verdict: "Not legal", detail: illegal("M", m[1]!) + after };
  }

  if ((m = /^bounced with\s*(.*)$/.exec(reason))) {
    const who = places(names, m[1] ?? "");
    if (kind === "R") {
      return {
        tone: "fail",
        verdict: "Bounced",
        detail: who
          ? `Another retreat from ${who} was headed for the same province, so the unit was disbanded.`
          : "Another retreat was headed for the same province, so the unit was disbanded.",
      };
    }
    return {
      tone: "fail",
      verdict: "Bounced",
      detail: who ? `Bounced with the unit from ${who}. Nobody moved.` : "Bounced. Nobody moved.",
    };
  }
  if ((m = /^repelled by (\w+)/.exec(reason))) {
    return { tone: "fail", verdict: "Repelled", detail: `The unit in ${place(names, m[1]!)} held its ground.` };
  }
  if ((m = /^lost head-to-head with (\w+)/.exec(reason))) {
    return {
      tone: "fail",
      verdict: "Bounced",
      detail: `Met the unit from ${place(names, m[1]!)} head on and did not have the strength to win.`,
    };
  }
  if (reason === "no convoy path") {
    return { tone: "fail", verdict: "No convoy", detail: "No unbroken chain of fleets carried the army across." };
  }
  if (reason === "cannot dislodge own unit") {
    return { tone: "fail", verdict: "Stopped", detail: "A power cannot dislodge its own unit." };
  }
  if ((m = /^supporter dislodged by (\w+)/.exec(reason))) {
    return {
      tone: "fail",
      verdict: "Dislodged",
      detail: `Dislodged by the attack from ${place(names, m[1]!)}, so its support counted for nothing.`,
    };
  }
  if ((m = /^convoy dislodged by (\w+)/.exec(reason))) {
    return {
      tone: "fail",
      verdict: "Dislodged",
      detail: `Dislodged by the attack from ${place(names, m[1]!)}, which broke the convoy.`,
    };
  }
  if ((m = /^dislodged by (\w+)/.exec(reason))) {
    return { tone: "fail", verdict: "Dislodged", detail: `Dislodged by the attack from ${place(names, m[1]!)}.` };
  }
  if ((m = /^support cut by (\w+)/.exec(reason))) {
    return { tone: "fail", verdict: "Support cut", detail: `Cut by the attack from ${place(names, m[1]!)}.` };
  }
  if (reason.startsWith("support void")) {
    return {
      tone: "fail",
      verdict: "Support wasted",
      detail: "The unit it backed was not ordered to do that, so the support went nowhere.",
    };
  }
  if (reason.startsWith("convoy void")) {
    return {
      tone: "fail",
      verdict: "Convoy wasted",
      detail: "The army was not ordered to make that crossing, so the convoy went unused.",
    };
  }
  if (reason.startsWith("convoy fails") || result.code === "paradox") {
    return {
      tone: "fail",
      verdict: "Paradox",
      detail: "A convoy paradox: the orders contradict each other, so by the Szykman rule the convoy fails.",
    };
  }
  if (reason === "disbanded" || result.code === "disband") {
    return { tone: "neutral", verdict: "Disbanded", detail: "The unit was disbanded." };
  }

  // Something the engine learned to say after this file was written: show its words, tidied.
  const cleaned = reason.replace(/\((\w+)\)/g, (_, code: string) => `(${wordsFromCode(code)})`);
  return { tone: "fail", verdict: "Failed", detail: sentence(cleaned || wordsFromCode(result.code)) };
}

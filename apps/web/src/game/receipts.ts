/**
 * How an order went, in plain words: the one place for that copy. The sidebar's receipts and the
 * Why panel (explain/explain.ts) both take their stamps, sentences, notes and labels from here,
 * so a failed order reads the same wherever it is opened.
 *
 * The engine explains every order with a short code and a terse reason written for logs
 * (`illegal (AllowanceUsed)`, `bounced with PAR`). Players get a sentence instead. Every code and
 * reason the engine can produce is covered here; anything new falls back to readable words,
 * never to a raw enum name.
 */
import type { OrderResult } from "../engine.js";
import { type PhaseKind, parseOrder, parseUnit, phaseKind, provinceOf } from "./notation.js";

export interface Receipt {
  /** `ok` succeeded, `fail` did not, `neutral` is a disband the player asked for. */
  tone: "ok" | "fail" | "neutral";
  /** Two or three words for a stamp: `Bounced`, `Support cut`. */
  verdict: string;
  /** One sentence. Empty when the order simply worked. */
  detail: string;
}

/** The board's provinces by code, for putting place names in a sentence. */
export type Names = Record<string, { name: string } | undefined>;

/**
 * The stamp for each engine code (crates/cabal-engine/src/text.rs `outcome_code`). A head-to-head
 * is a bounce whether it was lost or tied, so it is stamped as one; the sentence says which.
 */
export const VERDICTS: Record<string, string> = {
  ok: "Succeeded",
  bounce: "Bounced",
  repelled: "Repelled",
  head_to_head: "Bounced",
  own_unit: "Stopped",
  no_path: "No convoy",
  cut: "Support cut",
  void: "Wasted",
  support_void: "Support wasted",
  convoy_void: "Convoy wasted",
  dislodged: "Dislodged",
  paradox: "Paradox",
  illegal: "Not legal",
  disband: "Disbanded",
};

/** The stamp for an order that ended with `code`. A wasted support or convoy says which it was. */
export function verdictFor(code: string, order?: string): string {
  if (code === "void" && order) {
    const type = parseOrder(order)?.type;
    if (type === "support-move" || type === "support-hold") return VERDICTS["support_void"]!;
    if (type === "convoy") return VERDICTS["convoy_void"]!;
  }
  return VERDICTS[code] ?? "Failed";
}

/** What a circle of orders that depend on each other means, by the rule that settled it. */
const CYCLE_NOTES: Record<string, string> = {
  convoy_paradox:
    "These orders depend on each other in a circle: a convoy paradox. By the Szykman rule the convoys in the circle fail, so the army stays where it is and everything else is judged without it.",
  circular_movement: "These moves form a circle, each into the next one's province. They all succeed together.",
  unresolved: "These orders depend on each other in a circle that no rule settles, so every order in it fails.",
};

export function cycleNote(kind: string): string {
  return CYCLE_NOTES[kind] ?? "These orders depend on each other in a circle, settled by a backup rule.";
}

/** How the Why panel labels each side of a contest. */
export const SIDES = {
  move: "This move",
  convoyed: "Crossing by convoy",
  held: "Held by",
  headOn: "Coming the other way",
  rival: "Also moving in",
} as const;

const COASTS: Record<string, string> = { NC: "north coast", SC: "south coast", EC: "east coast", WC: "west coast" };

/**
 * Put place names in the engine's sentence: `bounced in BUR` reads `bounced in Burgundy`.
 * Units keep their notation (`A MUN`), which players read faster than a name.
 */
export function namePlaces(sentence: string, names?: Names): string {
  if (!names) return sentence;
  return sentence.replace(/\b([AF] )?([A-Z]{3})(?:\/([NSEW]C))?\b/g, (whole, unit: string | undefined, code: string, coast?: string) => {
    if (unit) return whole;
    const name = names[code]?.name;
    if (!name) return whole;
    return coast ? `${name} (${COASTS[coast] ?? coast})` : name;
  });
}

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

/** How hard a move pushed: itself plus every support for it that was not cut or wasted. */
function moveStrength(move: OrderResult, all: readonly OrderResult[]): number | null {
  const order = parseOrder(move.order);
  if (order?.type !== "move") return null;
  let strength = 1;
  for (const r of all) {
    if (!r.ok) continue;
    const s = parseOrder(r.order);
    if (s?.type !== "support-move") continue;
    if (s.target.province === order.unit.province && provinceOf(s.dest) === provinceOf(order.dest)) strength += 1;
  }
  return strength;
}

function resultAt(all: readonly OrderResult[], province: string): OrderResult | undefined {
  return all.find((r) => parseUnit(r.unit || r.order)?.province === province.trim());
}

/**
 * How a bounce went. The engine has one word for a tie and for losing to a stronger move,
 * so the supports that counted are added up from the phase's other results. When the sums
 * do not settle it (a rule this tally does not know), the wording stays non-committal.
 */
function bounceDetail(result: OrderResult, rivals: string[], who: string, all: readonly OrderResult[] | undefined): string {
  const units = rivals.length > 1 ? "units" : "unit";
  const mine = all ? moveStrength(result, all) : null;
  const theirs = all ? rivals.map((code) => {
    const r = resultAt(all, code);
    return r ? moveStrength(r, all) : null;
  }) : [];
  if (mine !== null && theirs.length > 0 && theirs.every((t): t is number => t !== null)) {
    const strongest = Math.max(...theirs);
    if (strongest === mine && theirs.every((t) => t === mine)) {
      return `Bounced with the ${units} from ${who}: equal strength, so nobody got in.`;
    }
    if (theirs.every((t) => t > mine)) {
      return `Bounced by the ${units} from ${who}, which had more support.`;
    }
  }
  return `Bounced with the ${units} from ${who}, which had at least as much strength.`;
}

/**
 * Turn one engine result into a receipt. `names` (the board's provinces) turns codes into
 * place names; without it the three-letter codes are kept. `all` is every result of the same
 * phase: with it a receipt can say what the other unit was doing.
 */
export function receiptFor(result: OrderResult, phase: string, names?: Names, all?: readonly OrderResult[]): Receipt {
  const kind = phaseKind(phase);
  const reason = result.reason.trim();
  if (result.ok) return { tone: "ok", verdict: verdictFor("ok"), detail: "" };

  let m: RegExpExecArray | null;

  // Illegal orders, in each phase's own wording.
  if ((m = /^illegal retreat \((\w+)\)/.exec(reason))) {
    return { tone: "fail", verdict: verdictFor("illegal"), detail: `${illegal("R", m[1]!)} The unit was disbanded.` };
  }
  if ((m = /^illegal \((\w+)\)(?:, holds)?(?:, dislodged by (\w+))?/.exec(reason))) {
    if (kind === "A") return { tone: "fail", verdict: verdictFor("illegal"), detail: illegal("A", m[1]!) };
    const after = m[2]
      ? ` The unit held instead and was dislodged by the attack from ${place(names, m[2])}.`
      : " The unit held instead.";
    return { tone: "fail", verdict: verdictFor("illegal"), detail: illegal("M", m[1]!) + after };
  }

  if ((m = /^bounced with\s*(.*)$/.exec(reason))) {
    const who = places(names, m[1] ?? "");
    if (kind === "R") {
      return {
        tone: "fail",
        verdict: verdictFor("bounce"),
        detail: who
          ? `Another retreat from ${who} was headed for the same province, so the unit was disbanded.`
          : "Another retreat was headed for the same province, so the unit was disbanded.",
      };
    }
    return {
      tone: "fail",
      verdict: verdictFor("bounce"),
      detail: who
        ? bounceDetail(result, (m[1] ?? "").split(",").map((c) => c.trim()).filter(Boolean), who, all)
        : "Bounced: it did not have the strength to get in.",
    };
  }
  if ((m = /^repelled by (\w+)/.exec(reason))) {
    // "Held its ground" would be wrong for a unit that tried to leave and bounced back.
    const there = all ? resultAt(all, m[1]!) : undefined;
    const tried = there && !there.ok && parseOrder(there.order)?.type === "move";
    const where = place(names, m[1]!);
    return {
      tone: "fail",
      verdict: verdictFor("repelled"),
      detail: tried
        ? `The unit in ${where} failed to move out, and the attack was not strong enough to dislodge it.`
        : `The unit in ${where} stayed put, and the attack was not strong enough to dislodge it.`,
    };
  }
  if ((m = /^lost head-to-head with (\w+)/.exec(reason))) {
    return {
      tone: "fail",
      verdict: verdictFor("head_to_head"),
      detail: `Met the unit from ${place(names, m[1]!)} head on and did not have the strength to win.`,
    };
  }
  if (reason === "no convoy path") {
    return { tone: "fail", verdict: verdictFor("no_path"), detail: "No unbroken chain of fleets carried the army across." };
  }
  if (reason === "cannot dislodge own unit") {
    return { tone: "fail", verdict: verdictFor("own_unit"), detail: "A power cannot dislodge its own unit." };
  }
  if ((m = /^supporter dislodged by (\w+)/.exec(reason))) {
    return {
      tone: "fail",
      verdict: verdictFor("dislodged"),
      detail: `Dislodged by the attack from ${place(names, m[1]!)}, so its support counted for nothing.`,
    };
  }
  if ((m = /^convoy dislodged by (\w+)/.exec(reason))) {
    return {
      tone: "fail",
      verdict: verdictFor("dislodged"),
      detail: `Dislodged by the attack from ${place(names, m[1]!)}, which broke the convoy.`,
    };
  }
  if ((m = /^dislodged by (\w+)/.exec(reason))) {
    return { tone: "fail", verdict: verdictFor("dislodged"), detail: `Dislodged by the attack from ${place(names, m[1]!)}.` };
  }
  if ((m = /^support cut by (\w+)/.exec(reason))) {
    return { tone: "fail", verdict: verdictFor("cut"), detail: `Cut by the attack from ${place(names, m[1]!)}.` };
  }
  if (reason.startsWith("support void")) {
    return {
      tone: "fail",
      verdict: verdictFor("support_void"),
      detail: "The unit it backed was not ordered to do that, so the support went nowhere.",
    };
  }
  if (reason.startsWith("convoy void")) {
    return {
      tone: "fail",
      verdict: verdictFor("convoy_void"),
      detail: "The army was not ordered to make that crossing, so the convoy went unused.",
    };
  }
  if (reason.startsWith("convoy fails") || result.code === "paradox") {
    return {
      tone: "fail",
      verdict: verdictFor("paradox"),
      detail: "A convoy paradox: the orders contradict each other, so by the Szykman rule the convoy fails.",
    };
  }
  if (reason === "disbanded" || result.code === "disband") {
    return { tone: "neutral", verdict: verdictFor("disband"), detail: "The unit was disbanded." };
  }

  // Something the engine learned to say after this file was written: show its words, tidied.
  const cleaned = reason.replace(/\((\w+)\)/g, (_, code: string) => `(${wordsFromCode(code)})`);
  return { tone: "fail", verdict: verdictFor(result.code, result.order), detail: sentence(cleaned || wordsFromCode(result.code)) };
}

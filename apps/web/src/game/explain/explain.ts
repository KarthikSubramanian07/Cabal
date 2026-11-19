/**
 * Why an order failed, in the player's terms: the engine's own explanation of a movement
 * phase (`explain`, `explainPreview`) turned into what the panel shows and what the board
 * picks out. Strengths on each side, the supports that counted and the ones that were cut
 * and by whom, a convoy that broke, the paradox rule that settled a circle, and one sentence.
 *
 * Retreats and adjustments have no engine explanation; for those the result's own words and
 * the units it names (`by`) are used. Pure apart from calling the engine.
 */
import { type Explanation, type OrderExplanation, type OrderResult, type State, explainPreview } from "@cabal/engine";
import type { BoardHighlight } from "../../map/Board.jsx";
import { type OrderBook, flatten } from "../book.js";
import { parseOrder, parseUnit, phaseKind } from "../notation.js";
import { receiptFor } from "../receipts.js";

export type Names = Record<string, { name: string } | undefined>;

/** One side of a contest: who, and how strong. */
export interface Side {
  /** `Your move`, `Held by`, `Also moving in`. */
  role: string;
  /** `A MUN`, or null for an empty province. */
  unit: string | null;
  strength: number;
}

export interface Why {
  unit: string;
  order: string;
  ok: boolean;
  code: string;
  /** Two or three words for a stamp: `Bounced`, `Support cut`. */
  verdict: string;
  /** One or two plain sentences, places named. */
  sentence: string;
  /** Moves: this order's strength against what stood in its way. */
  contest: { mine: Side; against: Side[] } | null;
  /** Units that stayed: the hold strength and the moves against it. */
  defence: { hold: number; attacks: { unit: string; strength: number; succeeded: boolean }[] } | null;
  /** Supports given to this order. */
  supports: { unit: string; counted: boolean; code: string; cutBy: string[] }[];
  /** This is a support: the units whose attack cut it. */
  cutBy: string[];
  /** A move by convoy: the fleets and what happened to each. */
  convoys: { unit: string; code: string; dislodgedBy: string | null }[];
  /** A move by convoy: whether a whole chain of fleets carried it. */
  convoyPath: boolean | null;
  /** A circle of orders settled by a backup rule. */
  cycle: { kind: string; note: string; orders: string[] } | null;
  /** What the board picks out for this order. */
  highlight: BoardHighlight;
}

const CYCLE_NOTES: Record<string, string> = {
  convoy_paradox:
    "These orders depend on each other in a circle: a convoy paradox. By the Szykman rule the convoys in the circle fail, so the army stays where it is and everything else is judged without it.",
  circular_movement: "These moves form a circle, each into the next one's province. They all succeed together.",
  unresolved: "These orders depend on each other in a circle that no rule settles, so every order in it fails.",
};

/** The stamp for each engine code. */
export const VERDICTS: Record<string, string> = {
  ok: "Succeeded",
  bounce: "Bounced",
  repelled: "Repelled",
  head_to_head: "Beaten head on",
  own_unit: "Stopped",
  no_path: "No convoy",
  cut: "Support cut",
  void: "Wasted",
  dislodged: "Dislodged",
  paradox: "Paradox",
  illegal: "Not legal",
  disband: "Disbanded",
};

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

const provinceOfUnit = (unit: string | null | undefined): string | null => (unit ? (parseUnit(unit)?.province ?? null) : null);

function uniq<T>(list: T[]): T[] {
  return [...new Set(list)];
}

/** The panel for one order of an explained movement phase. */
export function whyOf(ex: Explanation, index: number, names?: Names): Why | null {
  const o: OrderExplanation | undefined = ex.orders[index];
  if (!o) return null;
  let contest: Why["contest"] = null;
  if (o.attack !== null && o.attack !== undefined) {
    const against: Side[] = [];
    const opp = o.opposition;
    if (opp && opp.kind !== "empty") {
      against.push({ role: opp.kind === "head_to_head" ? "Coming the other way" : "Held by", unit: opp.unit ?? null, strength: opp.strength });
    }
    for (const r of o.rivals) against.push({ role: "Also moving in", unit: r.unit, strength: r.strength });
    contest = { mine: { role: o.by_convoy ? "Crossing by convoy" : "This move", unit: o.unit, strength: o.attack }, against };
  }
  const defence =
    // Only when something came at it: an illegal order turned into a hold has no ledger to show.
    o.hold !== null && o.hold !== undefined && o.attacks.length > 0
      ? { hold: o.hold, attacks: o.attacks.map((a) => ({ unit: a.unit, strength: a.strength, succeeded: a.succeeded })) }
      : null;
  // A convoyed army is not in its convoy's circle itself, but the circle is why it failed.
  const viaConvoy = o.convoys
    .map((c) => ex.orders.find((x) => x.unit === c.unit && x.cycle !== null && x.cycle !== undefined)?.cycle)
    .find((c) => c !== null && c !== undefined);
  const cycleAt = o.cycle ?? viaConvoy;
  const cycleInfo = cycleAt !== null && cycleAt !== undefined ? ex.cycles[cycleAt] : undefined;
  const cycle = cycleInfo
    ? {
        kind: cycleInfo.kind,
        note: CYCLE_NOTES[cycleInfo.kind] ?? "These orders depend on each other in a circle, settled by a backup rule.",
        orders: cycleInfo.members.map((i) => ex.orders[i]?.order ?? "").filter(Boolean),
      }
    : null;

  const allies = [
    ...o.supports.filter((s) => s.counted).map((s) => s.unit),
    ...o.convoys.filter((c) => c.code === "ok").map((c) => c.unit),
  ];
  const against = [
    ...o.by,
    ...(o.opposition?.unit && !o.ok ? [o.opposition.unit] : []),
    ...(o.ok ? [] : o.rivals.map((r) => r.unit)),
    ...o.cut_by,
    ...o.attacks.filter((a) => a.succeeded || !o.ok).map((a) => a.unit),
    ...o.supports.flatMap((s) => s.cut_by),
    ...o.convoys.flatMap((c) => (c.dislodged_by ? [c.dislodged_by] : [])),
  ];
  const cycleUnits = cycleInfo ? cycleInfo.members.map((i) => ex.orders[i]?.unit ?? "").filter(Boolean) : [];
  const helpers = [...o.supports.map((s) => s.unit), ...o.convoys.map((c) => c.unit)];
  const highlight: BoardHighlight = {
    focus: provinceOfUnit(o.unit) ?? undefined,
    allies: uniq(allies.map(provinceOfUnit).filter((p): p is string => Boolean(p))),
    against: uniq(against.map(provinceOfUnit).filter((p): p is string => Boolean(p))),
    units: uniq([o.unit, ...helpers, ...against, ...cycleUnits]),
  };
  return {
    unit: o.unit,
    order: o.order,
    ok: o.ok,
    code: o.code,
    // The engine's own code, as on the receipt: in a paradox each order in the circle still failed
    // its own way (a bounce, no convoy); the circle's note says why.
    verdict: o.ok ? "Succeeded" : (VERDICTS[o.code] ?? "Failed"),
    sentence: namePlaces(o.sentence, names),
    contest,
    defence,
    supports: o.supports.map((s) => ({ unit: s.unit, counted: s.counted, code: s.code, cutBy: s.cut_by })),
    cutBy: o.cut_by,
    convoys: o.convoys.map((c) => ({ unit: c.unit, code: c.code, dislodgedBy: c.dislodged_by ?? null })),
    convoyPath: o.convoy_path ?? null,
    cycle,
    highlight,
  };
}

/** For phases the engine does not explain (retreats, adjustments): the result's own account. */
export function whyOfResult(result: OrderResult, phase: string, names?: Names, all?: readonly OrderResult[]): Why {
  const receipt = receiptFor(result, phase, names, all);
  const by = result.by ?? [];
  return {
    unit: result.unit,
    order: result.order,
    ok: result.ok,
    code: result.code,
    verdict: receipt.verdict,
    sentence: receipt.detail || namePlaces(result.summary ?? result.reason, names),
    contest: null,
    defence: null,
    supports: [],
    cutBy: [],
    convoys: [],
    convoyPath: null,
    cycle: null,
    highlight: {
      focus: provinceOfUnit(result.unit) ?? undefined,
      against: uniq(by.map(provinceOfUnit).filter((p): p is string => Boolean(p))),
      units: uniq([result.unit, ...by]),
    },
  };
}

/** A phase as the sandbox and the replay keep it. */
export interface ExplainablePhase {
  phase: string;
  state: State;
  orders: OrderBook;
}

/**
 * The engine's explanation of a movement phase, re-run from the position it began with and the
 * orders written for it, or null for retreats and adjustments (and a phase that cannot be
 * re-run). The same answer `Game.explain(index)` gives, without needing the game's history,
 * so a replay or a room can ask it of any phase it has the record of.
 */
export function explainPhase(record: ExplainablePhase): Explanation | null {
  if (phaseKind(record.phase) !== "M") return null;
  try {
    return explainPreview(record.state, { orders: flatten(record.orders) });
  } catch {
    return null;
  }
}

/** The index in an explanation of the result for `unit` (`A PAR`) of `power`. */
export function indexOfUnit(ex: Explanation, power: string, unit: string): number {
  const want = parseUnit(unit)?.unit;
  return ex.orders.findIndex((o) => o.power === power && parseUnit(o.unit)?.unit === want);
}

/** Whether a result is worth a "why": it failed, or a unit was dislodged. */
export function hasWhy(result: OrderResult): boolean {
  return !result.ok && result.code !== "disband" && parseOrder(result.order)?.type !== "waive";
}

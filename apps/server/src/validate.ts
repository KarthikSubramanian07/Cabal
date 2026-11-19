/**
 * Judging submitted orders against the board: the one seam between the room and the engine for
 * order legality. The room calls `judgeOrders` and stores only what it accepts, so `orders.ack`
 * tells a player the truth before the deadline, never after it.
 *
 * The verdicts are the engine's own (`game.validateOrders`), which asks exactly what adjudication
 * asks: an order is legal here when the resolver would not throw it out. On top of that the room
 * keeps one rule of its own: when a unit (or, in a winter phase, a province) is given two orders,
 * the last one sent stands and the earlier one is `superseded`, where the engine would call both
 * `duplicate_order`. Each verdict carries a coarse `code` that clients have always matched on and
 * the engine's finer reason as `detail`.
 */
import type { OrderVerdict } from "@cabal/protocol";
import type { Game, OrderVerdict as EngineVerdict } from "./engine.js";

export type PhaseKind = "M" | "R" | "A";

export interface Judgement {
  /** Canonical orders to put on file: every order that was accepted, in the order sent. */
  accepted: string[];
  /** One verdict per order sent, in the order sent. */
  verdicts: OrderVerdict[];
}

/** `A PAR - BUR` -> `A PAR`; `F STP/SC - BOT` -> `F STP/SC`; `WAIVE` -> null. */
function unitOf(order: string): string | null {
  return /^([AF] [A-Z]{3}(?:\/[A-Z]{2})?)(?: |$)/.exec(order)?.[1] ?? null;
}

const province = (unit: string) => unit.slice(2, 5);

/** The engine's reason, as the coarse code clients match on. Anything not listed is `illegal`. */
const COARSE: Record<string, { code: string }> = {
  unparseable: { code: "syntax" },
  wrong_phase: { code: "syntax" },
  unknown_power: { code: "syntax" },
  wrong_power: { code: "foreign_power" },
  no_unit: { code: "no_such_unit" },
  foreign_unit: { code: "no_such_unit" },
  not_dislodged: { code: "no_such_unit" },
  allowance_used: { code: "over_allowance" },
  duplicate_order: { code: "superseded" },
};
const ILLEGAL = { code: "illegal" };

/** Engine reasons for an order that never reached one of the power's own units. */
const NOT_OURS = new Set(["unparseable", "wrong_phase", "unknown_power", "wrong_power", "no_unit", "foreign_unit", "not_dislodged"]);

/** What two orders compete for: the unit, or in a winter phase the province built in or disbanded from. */
function slot(kind: PhaseKind, v: EngineVerdict): string | null {
  if (NOT_OURS.has(v.code) || v.canonical === null) return null;
  const unit = v.unit ?? unitOf(v.canonical);
  if (unit === null) return null; // a waive
  return kind === "A" ? province(unit) : unit.replace(/\/[A-Z]{2}$/, "");
}

function toVerdict(v: EngineVerdict): OrderVerdict {
  if (v.legal) return { text: v.input, order: v.canonical, ok: true, code: "ok", reason: "" };
  return { text: v.input, order: v.canonical, ok: false, code: (COARSE[v.code] ?? ILLEGAL).code, reason: v.reason, detail: v.code };
}

/**
 * Judge `texts` as the orders `power` wants on file for the current phase.
 *
 * The engine judges the whole list at once (two orders for one unit, builds past the allowance),
 * so the list is judged twice: once to find which orders compete for the same slot, and again
 * without the superseded ones, which gives the verdicts of the orders that stand.
 */
export function judgeOrders(game: Game, power: string, kind: PhaseKind, texts: string[]): Judgement {
  const first = game.validateOrders(power, texts);
  const bySlot = new Map<string, number[]>();
  first.forEach((v, i) => {
    const key = slot(kind, v);
    if (key !== null) bySlot.set(key, [...(bySlot.get(key) ?? []), i]);
  });
  // Of several orders for one slot, only the ones that would be legal on their own compete, and
  // the last of those stands: a mistyped correction never wipes out a good order sent before it.
  // The others are judged on their own, as if they had been sent alone.
  const superseded = new Map<number, string>();
  const alone = new Map<number, EngineVerdict>();
  for (const [key, indices] of bySlot) {
    if (indices.length < 2) continue;
    const legal: number[] = [];
    for (const i of indices) {
      const verdict = game.validateOrders(power, [texts[i]!])[0]!;
      if (verdict.legal) legal.push(i);
      else alone.set(i, verdict);
    }
    for (const i of legal.slice(0, -1)) superseded.set(i, key);
  }
  const standing = texts.map((_, i) => i).filter((i) => !superseded.has(i) && !alone.has(i));
  const second = superseded.size === 0 && alone.size === 0 ? first : game.validateOrders(power, standing.map((i) => texts[i]!));
  const verdicts: OrderVerdict[] = Array.from({ length: texts.length });
  standing.forEach((i, k) => {
    verdicts[i] = toVerdict(second[k]!);
  });
  for (const [i, verdict] of alone) verdicts[i] = toVerdict(verdict);
  for (const [i, key] of superseded) {
    verdicts[i] = { text: texts[i]!, order: first[i]!.canonical, ok: false, code: "superseded", reason: `replaced by a later order for ${key}`, detail: "duplicate_order" };
  }
  return { accepted: verdicts.filter((v) => v.ok).map((v) => v.order!), verdicts };
}

/**
 * A pledge's orders in canonical text, judged against the board by the engine: every order must
 * be one a unit of `power` could be given this phase. Throws, with a sentence, when one is not.
 */
export function checkPledge(game: Game, power: string, orders: string[]): string[] {
  return game.pledgeCheck(power, orders);
}

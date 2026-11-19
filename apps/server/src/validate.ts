/**
 * Judging submitted orders against the board: the one seam between the room and the engine for
 * order legality. The room calls `judgeOrders` and stores only what it accepts, so `orders.ack`
 * tells a player the truth before the deadline, never after it.
 *
 * The verdicts are derived from the engine's own legal-order menu for the position, which lists
 * every hold, move (by land, sea or convoy), support and convoy each unit may be given, every
 * retreat of each dislodged unit, and every build or disband. An order is legal exactly when the
 * menu holds it. If the engine grows a dedicated validator, this function is the only caller to
 * change.
 */
import type { OrderVerdict } from "@cabal/protocol";
import type { Game } from "./engine.js";

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

/**
 * @param canonical parses one order under the seat's own power, or throws with the reason.
 */
export function judgeOrders(game: Game, power: string, kind: PhaseKind, texts: string[], canonical: (text: string) => string): Judgement {
  const legal = game.legal(power);
  /** Canonical spelling of every legal order -> the menu key (unit) it belongs to. */
  const menu = new Map<string, string>();
  for (const [unit, options] of Object.entries(legal.by_unit)) {
    for (const option of options) {
      menu.set(option, unit);
      try {
        menu.set(canonical(option), unit);
      } catch {
        // the menu's own spelling is already in the map
      }
    }
  }
  const units = Object.keys(legal.by_unit).filter((unit) => unit !== "");

  const verdicts: OrderVerdict[] = [];
  /** Index into `verdicts` of the accepted order for each unit (or each built province). */
  const holder = new Map<string, number>();
  let waives = 0;

  for (const text of texts) {
    let order: string;
    try {
      order = canonical(text);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      verdicts.push(
        reason === "order names another power"
          ? { text, order: null, ok: false, code: "foreign_power", reason }
          : { text, order: null, ok: false, code: "syntax", reason },
      );
      continue;
    }
    if (kind === "M") {
      // The engine fills in what the board makes unambiguous (a coast, a convoy route).
      try {
        order = game.normaliseOrders({ orders: { [power]: [order] } }).orders[power]?.[0] ?? order;
      } catch {
        // judged below as written
      }
    }
    if (!menu.has(order)) {
      const unit = unitOf(order);
      const known = unit !== null && (kind === "A" ? true : units.some((u) => province(u) === province(unit)));
      verdicts.push(
        known
          ? { text, order, ok: false, code: "illegal", reason: illegalReason(kind, unit) }
          : { text, order, ok: false, code: "no_such_unit", reason: noUnitReason(kind, unit) },
      );
      continue;
    }
    // One order per unit; in an adjustment phase, one per province. The last one sent stands.
    const key = kind === "A" ? (unitOf(order) ? province(unitOf(order)!) : `WAIVE#${waives++}`) : menu.get(order)!;
    const earlier = holder.get(key);
    if (earlier !== undefined) {
      verdicts[earlier] = { ...verdicts[earlier]!, ok: false, code: "superseded", reason: `replaced by a later order for ${kind === "A" ? key : menu.get(order)}` };
    }
    holder.set(key, verdicts.length);
    verdicts.push({ text, order, ok: true, code: "ok", reason: "" });
  }

  if (kind === "A") {
    // Never more builds or disbands than the allowance: the first ones sent stand.
    const allowed = Math.abs(legal.allowance);
    let kept = 0;
    for (let i = 0; i < verdicts.length; i++) {
      const v = verdicts[i]!;
      if (!v.ok) continue;
      if (++kept > allowed) {
        verdicts[i] = { ...v, ok: false, code: "over_allowance", reason: `you have ${allowed} ${legal.allowance < 0 ? "disband" : "build"}${allowed === 1 ? "" : "s"} this phase` };
      }
    }
  }

  return { accepted: verdicts.filter((v) => v.ok).map((v) => v.order!), verdicts };
}

function illegalReason(kind: PhaseKind, unit: string | null): string {
  if (kind === "A") return "that is not a build or disband you may order this phase";
  if (kind === "R") return `${unit} cannot retreat there`;
  return `${unit} cannot be given that order on this board`;
}

function noUnitReason(kind: PhaseKind, unit: string | null): string {
  if (unit === null) return "that order names no unit";
  if (kind === "R") return `${unit} is not one of your dislodged units`;
  return `you have no unit at ${province(unit)}`;
}

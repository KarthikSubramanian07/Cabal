/**
 * Judging submitted orders against the board: the one seam between the room and the engine for
 * order legality. The room calls `judgeOrders` and stores only what it accepts, so `orders.ack`
 * tells a player the truth before the deadline, never after it.
 *
 * The verdicts are derived from the engine's own legal-order menu for the position, which lists
 * every hold, move (by land, sea or convoy), support and convoy each unit may be given, every
 * retreat of each dislodged unit, and every build or disband. A movement or adjustment order is
 * legal exactly when the menu holds its text; a retreat is legal when the menu holds a retreat
 * from the same province to the same place (see `legalOrders`). If the engine grows a dedicated
 * validator, `legalOrders` is the only function to change.
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
 * A retreat or disband reduced to what identifies it: the province the unit was dislodged from and
 * where it goes. `A VEN R TUS` and `F VEN R TUS` are the same retreat, because a province holds one
 * dislodged unit: the letter is decoration, and the engine's own menu has been known to print the
 * attacker's letter there. Null when the text is not a retreat order.
 */
function retreatKey(order: string): { from: string; tail: string; to: string | null } | null {
  const m = /^[AF] ([A-Z]{3})(?:\/[A-Z]{2})? (?:R ([A-Z]{3})(\/[A-Z]{2})?|D)$/.exec(order);
  if (!m) return null;
  return m[2] ? { from: m[1]!, tail: `R ${m[2]}${m[3] ?? ""}`, to: m[2] } : { from: m[1]!, tail: "D", to: null };
}

export interface LegalOrders {
  /** The canonical text to put on file for a legal order, or null when the board does not allow it. */
  resolve(order: string): string | null;
  /** The unit (the menu's key) a resolved order belongs to. */
  unitFor(resolved: string): string;
  /** Units the power may order this phase. */
  units: string[];
  allowance: number;
}

/**
 * Everything `power` may legally order in the current phase, as a lookup from order text.
 *
 * Movement and adjustment orders are matched on their canonical text. Retreats are matched on the
 * dislodged unit's province and its destination, and come back spelled with the unit as the board
 * names it (`state.retreats`), whatever letter the caller or the engine's menu used.
 *
 * @param canonical parses one order under the power, or throws with the reason.
 */
export function legalOrders(game: Game, power: string, kind: PhaseKind, canonical: (text: string) => string): LegalOrders {
  const legal = game.legal(power);
  /** Order text (or retreat key) -> the canonical order and the menu key (unit) it belongs to. */
  const menu = new Map<string, { order: string; unit: string }>();
  for (const [unit, options] of Object.entries(legal.by_unit)) {
    for (const option of options) {
      if (kind === "R") {
        const key = retreatKey(option);
        if (!key) continue;
        const entry = { order: `${unit} ${key.tail}`, unit };
        menu.set(`${key.from} ${key.tail}`, entry);
        // A coast the board makes unambiguous may be left out: `F MAO R SPA` for `F MAO R SPA/SC`.
        if (key.to !== null && key.tail !== `R ${key.to}`) {
          const bare = `${key.from} R ${key.to}`;
          menu.set(bare, menu.has(bare) && menu.get(bare)!.order !== entry.order ? { order: "", unit } : entry);
        }
        continue;
      }
      menu.set(option, { order: option, unit });
      try {
        const spelled = canonical(option);
        if (!menu.has(spelled)) menu.set(spelled, { order: spelled, unit });
      } catch {
        // the menu's own spelling is already in the map
      }
    }
  }
  const owner = new Map<string, string>();
  const resolve = (order: string): string | null => {
    let found: { order: string; unit: string } | undefined;
    if (kind === "R") {
      const key = retreatKey(order);
      found = key ? menu.get(`${key.from} ${key.tail}`) : undefined;
      if (found?.order === "") found = undefined; // two coasts of one province are open: say which
    } else {
      found = menu.get(order);
    }
    if (!found) return null;
    owner.set(found.order, found.unit);
    return found.order;
  };
  return {
    resolve,
    unitFor: (resolved) => owner.get(resolved) ?? unitOf(resolved) ?? resolved,
    units: Object.keys(legal.by_unit).filter((unit) => unit !== ""),
    allowance: legal.allowance,
  };
}

/**
 * @param canonical parses one order under the seat's own power, or throws with the reason.
 */
export function judgeOrders(game: Game, power: string, kind: PhaseKind, texts: string[], canonical: (text: string) => string): Judgement {
  const legal = legalOrders(game, power, kind, canonical);
  const units = legal.units;

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
    const resolved = legal.resolve(order);
    if (resolved === null) {
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
    order = resolved;
    const key = kind === "A" ? (unitOf(order) ? province(unitOf(order)!) : `WAIVE#${waives++}`) : legal.unitFor(order);
    const earlier = holder.get(key);
    if (earlier !== undefined) {
      verdicts[earlier] = { ...verdicts[earlier]!, ok: false, code: "superseded", reason: `replaced by a later order for ${key}` };
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

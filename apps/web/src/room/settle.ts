/**
 * What a seat files when its player says "ready", and how the desk says what is on file. Pure, so
 * every phase kind is unit tested without React or a server.
 *
 * The server counts a phase as ordered on time only when the seat filed at least one order of
 * its own. A player who readies without writing anything has still decided: in a movement phase
 * their units hold, in a retreat phase their dislodged units disband, in a winter their builds are
 * waived and any disbands they owe fall where the rules put them. Each of those is filed as an
 * explicit order, so readying is never recorded as a missed turn.
 */
import { nextWaiveKey } from "../game/compose.js";
import { type PhaseKind, parseOrder } from "../game/notation.js";

export interface SettleInput {
  kind: PhaseKind;
  /** The seat's orders on this device, keyed as the order book keys them. */
  book: Readonly<Record<string, string>>;
  /** Legal orders by unit; adjustments under `""`. */
  legal: Readonly<Record<string, readonly string[]>>;
  /** Builds (positive) or disbands (negative) owed this winter. */
  allowance: number;
  /**
   * The units the rules would remove from this power if it chose no disbands (civil disorder),
   * in the rules' order. Asked for only when disbands are owed and not all chosen.
   */
  disorder?: () => readonly string[];
}

/** The book to file on "ready": the player's orders, with every decision left open made explicit. */
export function settledBook({ kind, book, legal, allowance, disorder }: SettleInput): Record<string, string> {
  const out: Record<string, string> = { ...book };
  let added = false;
  if (kind === "M" || kind === "R") {
    for (const unit of Object.keys(legal)) {
      if (unit === "" || out[unit] !== undefined || (legal[unit]?.length ?? 0) === 0) continue;
      out[unit] = kind === "M" ? `${unit} H` : `${unit} D`;
      added = true;
    }
  } else if (allowance > 0) {
    while (Object.keys(out).length < allowance) {
      out[nextWaiveKey(out)] = "WAIVE";
      added = true;
    }
  } else if (allowance < 0) {
    let owed = -allowance - Object.values(out).filter((text) => parseOrder(text)?.type === "disband").length;
    if (owed > 0) {
      const options = (legal[""] ?? []).filter((text) => parseOrder(text)?.type === "disband");
      const chosen = new Set(Object.values(out));
      const fromRules = (disorder?.() ?? []).map((unit) => `${unit} D`).filter((text) => options.includes(text));
      for (const text of [...fromRules, ...options]) {
        if (owed === 0) break;
        if (chosen.has(text)) continue;
        const order = parseOrder(text);
        if (order?.type !== "disband") continue;
        out[`D:${order.unit.province}`] = text;
        chosen.add(text);
        owed--;
        added = true;
      }
    }
  }
  return added ? out : (book as Record<string, string>);
}

export interface SyncInput {
  kind: PhaseKind;
  allowance: number;
  /** Orders on file. */
  given: number;
  /** Orders the seat has to give: units in a movement or retreat phase, builds or disbands in winter. */
  due: number;
}

/** The desk's line once everything written here is on file with the server. */
export function filedLine({ kind, allowance, given, due }: SyncInput): string {
  if (due === 0 && given === 0) {
    return kind === "A" ? "Nothing to build or disband this winter." : kind === "R" ? "None of your units has to retreat." : "You have no units to order.";
  }
  if (given === 0) {
    if (kind === "R") return "No retreats on file: your dislodged units disband.";
    if (kind === "A") {
      return allowance > 0 ? "No builds chosen: they are waived when you are ready." : "No disbands chosen: when you are ready, the rules choose which units go.";
    }
    return "No orders on file: your units hold.";
  }
  if (given >= due) return "Your orders are on file with the server.";
  if (kind === "R") return "Your retreats are on file. A dislodged unit without one disbands.";
  if (kind === "A") {
    return allowance > 0 ? "Your builds are on file. Any you leave unchosen are waived." : "Your disbands are on file. The rules choose any you leave unchosen.";
  }
  return "Your orders are on file. Units without one hold.";
}

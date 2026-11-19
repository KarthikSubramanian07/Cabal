/**
 * The order book: what has been written for the phase in progress, and the rules for
 * writing into it. Pure, so the caps and key handling are unit tested without React.
 */
import { nextWaiveKey } from "./compose.js";
import { type PhaseKind, parseUnit } from "./notation.js";

/** Orders keyed by power, then by unit (or `B:PAR` / `D:PAR` / `WAIVE:n` in adjustments). */
export type OrderBook = Record<string, Record<string, string>>;

/** Orders as the engine takes them: a list per power. */
export function flatten(book: OrderBook): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [power, entries] of Object.entries(book)) out[power] = Object.values(entries);
  return out;
}

/** Rebuild a book from saved order lists. */
export function toBook(orders: Record<string, string[]>, kind: PhaseKind): OrderBook {
  const book: OrderBook = {};
  for (const [power, list] of Object.entries(orders)) {
    let entries: Record<string, string> = {};
    for (const text of list) {
      const unit = parseUnit(text);
      if (kind === "A") {
        const key = text.trim() === "WAIVE" ? nextWaiveKey(entries) : `${text.trim().endsWith(" D") ? "D" : "B"}:${unit?.province}`;
        entries = { ...entries, [key]: text };
      } else if (unit) {
        entries = { ...entries, [unit.unit]: text };
      }
    }
    book[power] = entries;
  }
  return book;
}

/**
 * Write an order. In an adjustment phase a new entry is refused once the power has written
 * as many as it is owed; replacing an existing entry is always allowed.
 */
export function writeOrder(
  book: OrderBook,
  power: string,
  key: string,
  text: string,
  cap?: { kind: PhaseKind; allowance: number },
): OrderBook {
  const current = book[power] ?? {};
  if (cap?.kind === "A" && !(key in current) && Object.keys(current).length >= Math.abs(cap.allowance)) return book;
  return { ...book, [power]: { ...current, [key]: text } };
}

export function eraseOrder(book: OrderBook, power: string, key: string): OrderBook {
  if (!(key in (book[power] ?? {}))) return book;
  const next = { ...book[power] };
  delete next[key];
  return { ...book, [power]: next };
}

/** Give up one build. Only when builds are owed and not all spoken for. */
export function waiveBuild(book: OrderBook, power: string, allowance: number): OrderBook {
  const current = book[power] ?? {};
  if (allowance <= 0 || Object.keys(current).length >= allowance) return book;
  return { ...book, [power]: { ...current, [nextWaiveKey(current)]: "WAIVE" } };
}

/** Drop anything the current phase's legal lists do not contain (a stale autosave, an edited file). */
export function keepLegal(book: OrderBook, legal: Record<string, Record<string, string[]>>, kind: PhaseKind): OrderBook {
  const out: OrderBook = {};
  for (const [power, entries] of Object.entries(book)) {
    const mine = legal[power];
    if (!mine) continue;
    const kept: Record<string, string> = {};
    for (const [key, text] of Object.entries(entries)) {
      const ok = kind === "A" ? text === "WAIVE" || (mine[""] ?? []).includes(text) : (mine[key] ?? []).includes(text);
      if (ok) kept[key] = text;
    }
    if (Object.keys(kept).length) out[power] = kept;
  }
  return out;
}

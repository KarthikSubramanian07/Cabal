/**
 * What if, inside a live room: the seat sketches its own orders and guesses at everyone else's,
 * and the engine running here predicts the phase. Nothing in this module (or the sketch the room
 * keeps with `useWhatIf`) reaches the order desk or the server: the only way out is the explicit
 * "Use my sketched orders", which hands the seat's own sketch to the desk like any other edit.
 */
import type { Game } from "@cabal/engine";
import type { DrawnOrder, Ghost } from "../map/Board.jsx";
import type { OrderBook } from "../game/book.js";
import type { Prediction } from "../game/explain/whatIf.js";
import { type PhaseKind, parseOrder } from "../game/notation.js";
import { tidyLegal } from "../game/saved.js";

export interface Everyone {
  legal: Record<string, Record<string, string[]>>;
  allowance: Record<string, number>;
}

export const NOBODY: Everyone = { legal: {}, allowance: {} };

/** Every power's legal orders on `game`'s board, tidied as the order desk keeps them. */
export function legalForEveryone(game: Pick<Game, "legal" | "status" | "state">, kind: PhaseKind): Everyone {
  if (game.status() !== "active") return NOBODY;
  const out: Everyone = { legal: {}, allowance: {} };
  for (const power of Object.keys(game.state().units)) {
    const l = game.legal(power);
    out.legal[power] = tidyLegal(l.by_unit, kind);
    out.allowance[power] = l.allowance;
  }
  return out;
}

/** The powers with something to guess this phase, the seat's own first. */
export function sketchPowers(everyone: Everyone, me: string, kind: PhaseKind): string[] {
  const owes = (p: string) => {
    const units = Object.keys(everyone.legal[p] ?? {}).filter((u) => u !== "");
    return kind === "A" ? (everyone.allowance[p] ?? 0) !== 0 : units.length > 0;
  };
  const others = Object.keys(everyone.legal).filter((p) => p !== me && owes(p)).sort();
  return [me, ...others];
}

/** The sketch drawn on the board: every sketched order, each carrying its predicted result. */
export function sketchMarks(book: OrderBook, prediction: Prediction | null): DrawnOrder[] {
  return Object.entries(book).flatMap(([power, entries]) =>
    Object.values(entries).map((text): DrawnOrder => {
      const predicted = prediction?.outcome.results.find((r) => r.power === power && r.order === text);
      return predicted ? { power, text, ok: predicted.ok } : { power, text };
    }),
  );
}

/** Where the sketch would leave the units that move: dashed pieces on the board. */
export function sketchGhosts(prediction: Prediction | null): Ghost[] {
  if (!prediction) return [];
  const list: Ghost[] = [];
  for (const r of prediction.outcome.results) {
    const o = parseOrder(r.order);
    if (r.ok && (o?.type === "move" || o?.type === "retreat")) list.push({ power: r.power, kind: o.unit.kind, region: o.dest });
  }
  return list;
}

/** How many orders the sketch holds, for the sheet's handle. */
export function sketchCount(book: OrderBook): number {
  return Object.values(book).reduce((sum, o) => sum + Object.keys(o).length, 0);
}

/**
 * The line under a sketch when the seat's real orders, which keep filing while it is open, did not
 * all land: the failure, or how many the server refused. Null when they did.
 */
export function sketchSyncLine(error: string | null, refused: number): string | null {
  if (error) return `Your real orders were not filed: ${error}`;
  if (refused > 0) return `${refused === 1 ? "One of your real orders was" : `${refused} of your real orders were`} refused. Leave what if to see why.`;
  return null;
}

/**
 * Whether two sets of one power's orders say the same thing. Using a sketch replaces the seat's
 * orders with the copy it opened from plus what was sketched since, so a change made meanwhile on
 * another device holding the seat is worth telling the player about.
 */
export function sameOrders(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => b[k] === a[k]);
}

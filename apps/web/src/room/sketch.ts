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

/**
 * What each order on the board looks like, worked out from the orders as a set: a support
 * aims at the drawn middle of the move it backs, a convoy at the army's crossing, and a move
 * by convoy is drawn through the fleets carrying it. Pure, so it is unit tested; Board.tsx
 * only renders the shapes.
 *
 * Every kind of order differs in shape as well as colour (WCAG 1.4.1): moves are solid with a
 * barbed head, supports dashed with a round knot, convoys dotted with a square knot, holds a
 * solid ring, carrying fleets a dotted ring, builds a dashed ghost piece, disbands a cross.
 */
import { type ParsedOrder, parseOrder, provinceOf } from "../game/notation.js";
import type { Point } from "./boardData.js";
import { type Quad, convoyArrow, convoyedArrow, markSizes, moveArrow, supportHoldArrow, supportMoveArrow } from "./geometry.js";
import { carryingOrders, convoyChain } from "./route.js";

export type MarkShape =
  | { kind: "arrow"; cls: "move" | "move via" | "move via routed" | "retreat"; d: string; head: string; failAt: Point }
  | { kind: "helper"; cls: "support" | "convoy"; d: string; knot: { at: Point; r: number }; failAt: Point }
  | { kind: "ring"; cls: "hold" | "convoy carrying"; at: Point; r: number; failAt: Point }
  | { kind: "build"; at: Point; unit: "A" | "F" }
  | { kind: "disband"; at: Point; r: number };

export interface LaidMark {
  /** The order's text, as drawn. */
  text: string;
  /** The unit giving it, `A PAR`. */
  unit: string;
  shape: MarkShape;
}

/** The marks for a set of orders, in the order given; orders that cannot be read are left out. */
export function layoutMarks(texts: readonly string[], point: (region: string) => Point, r: number): (LaidMark | null)[] {
  const parsed = texts.map((t) => parseOrder(t));
  const carrying = carryingOrders(texts);
  const at = (region: string) => point(region);

  /** The drawn curve of each move, by `UNIT -> PROVINCE`, so helpers can aim at it. */
  const moves = new Map<string, Quad>();
  const routes = new Map<string, string[]>();
  texts.forEach((text, i) => {
    const o = parsed[i];
    if (o?.type !== "move") return;
    const route = o.via ? convoyChain(text, texts, at) : [];
    if (route.length) routes.set(text, route);
    const arrow = route.length
      ? convoyedArrow(at(o.unit.region), route.map(at), at(o.dest), r)
      : moveArrow(at(o.unit.region), at(o.dest), r);
    moves.set(`${o.unit.unit}>${provinceOf(o.dest)}`, arrow.drawn);
  });
  /** The curve a move would be drawn with, whether or not it was ordered. */
  const crossing = (unit: { unit: string; region: string }, dest: string) =>
    moves.get(`${unit.unit}>${provinceOf(dest)}`) ?? moveArrow(at(unit.region), at(dest), r).drawn;

  return texts.map((text, i) => {
    const o: ParsedOrder | null = parsed[i] ?? null;
    if (!o || o.type === "waive") return null;
    const from = at(o.unit.region);
    const s = markSizes(r);
    const mark = (shape: MarkShape): LaidMark => ({ text, unit: o.unit.unit, shape });
    switch (o.type) {
      case "hold":
        return mark({ kind: "ring", cls: "hold", at: from, r: s.ring, failAt: [from[0], from[1] - s.ring] });
      case "move":
      case "retreat": {
        const route = routes.get(text);
        if (o.type === "move" && route) {
          const a = convoyedArrow(from, route.map(at), at(o.dest), r);
          return mark({ kind: "arrow", cls: "move via routed", d: a.d, head: a.head, failAt: a.failAt });
        }
        const a = moveArrow(from, at(o.dest), r);
        const cls = o.type === "retreat" ? "retreat" : o.via ? "move via" : "move";
        return mark({ kind: "arrow", cls, d: a.d, head: a.head, failAt: a.failAt });
      }
      case "support-move": {
        const a = supportMoveArrow(from, crossing(o.target, o.dest), r);
        return mark({ kind: "helper", cls: "support", d: a.d, knot: a.knot, failAt: a.failAt });
      }
      case "support-hold": {
        const a = supportHoldArrow(from, at(o.target.region), r);
        return mark({ kind: "helper", cls: "support", d: a.d, knot: a.knot, failAt: a.failAt });
      }
      case "convoy": {
        if (carrying.has(text)) return mark({ kind: "ring", cls: "convoy carrying", at: from, r: s.ring, failAt: [from[0], from[1] - s.ring] });
        const a = convoyArrow(from, crossing(o.army, o.dest), r);
        return mark({ kind: "helper", cls: "convoy", d: a.d, knot: a.knot, failAt: a.failAt });
      }
      case "build":
        return mark({ kind: "build", at: from, unit: o.unit.kind });
      case "disband":
        return mark({ kind: "disband", at: from, r });
    }
  });
}

/** Moves by convoy and the fleets carrying them, by order text: what a marching army follows. */
export function convoyRoutes(texts: readonly string[], point: (region: string) => Point): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const text of texts) {
    const chain = convoyChain(text, texts, point);
    if (chain.length) out.set(text, chain);
  }
  return out;
}

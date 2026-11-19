/**
 * The route of a move by convoy, for drawing: which of the orders on the board are the
 * fleets carrying it, and in what order the army passes them.
 *
 * Pure, so the board stays a renderer and the route is unit tested.
 */
import { parseOrder, provinceOf } from "../game/notation.js";
import type { Point } from "./boardData.js";

/**
 * The fleets ordered to carry `move` (`A WAL - LON VIA`), as their regions, in the order the
 * army meets them: from the army outwards, each time the nearest fleet not yet passed. Empty
 * when `move` is not a move by convoy or nobody has been ordered to carry it.
 */
export function convoyChain(move: string, orders: readonly string[], point: (region: string) => Point): string[] {
  const parsed = parseOrder(move);
  if (parsed?.type !== "move" || !parsed.via) return [];
  const dest = provinceOf(parsed.dest);
  const fleets: string[] = [];
  for (const text of orders) {
    const o = parseOrder(text);
    if (o?.type === "convoy" && o.army.unit === parsed.unit.unit && provinceOf(o.dest) === dest) {
      if (!fleets.includes(o.unit.region)) fleets.push(o.unit.region);
    }
  }
  const chain: string[] = [];
  let at = point(parsed.unit.region);
  const left = [...fleets];
  while (left.length > 0) {
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    left.forEach((region, i) => {
      const p = point(region);
      const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    const [next] = left.splice(best, 1);
    chain.push(next!);
    at = point(next!);
  }
  return chain;
}

/** Convoy orders whose army's move by convoy is drawn through them, so they need no line of their own. */
export function carryingOrders(orders: readonly string[]): Set<string> {
  const moves = new Set<string>();
  for (const text of orders) {
    const o = parseOrder(text);
    if (o?.type === "move" && o.via) moves.add(`${o.unit.unit} - ${provinceOf(o.dest)}`);
  }
  const carrying = new Set<string>();
  for (const text of orders) {
    const o = parseOrder(text);
    if (o?.type === "convoy" && moves.has(`${o.army.unit} - ${provinceOf(o.dest)}`)) carrying.add(text);
  }
  return carrying;
}

/**
 * A smooth path from `from` through `via` to `to`: quadratic curves bent at each fleet, so
 * the army's track reads as one stroke of ink rather than a zig-zag.
 */
export function smoothPath(points: readonly Point[]): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  if (points.length < 2) return "";
  const [first, ...rest] = points;
  let d = `M${f(first![0])} ${f(first![1])}`;
  if (rest.length === 1) return `${d} L${f(rest[0]![0])} ${f(rest[0]![1])}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const c = rest[i]!;
    const n = rest[i + 1]!;
    const end = i === rest.length - 2 ? n : ([(c[0] + n[0]) / 2, (c[1] + n[1]) / 2] as Point);
    d += ` Q${f(c[0])} ${f(c[1])} ${f(end[0])} ${f(end[1])}`;
  }
  return d;
}

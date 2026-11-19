/**
 * When each order mark appears as a phase's results are shown. The adjudication is told in
 * the order it happened on the table: the units that stood and helped (holds, supports,
 * convoys) are inked first, then the moves are drawn, then each failure is stamped. The
 * standoffs land last.
 *
 * Pure numbers in milliseconds, handed to CSS as custom properties, so the stylesheet owns
 * how a mark moves and this module owns only the running order. Under reduced motion the
 * stylesheet ignores them all and every mark is simply there.
 */
import { parseOrder } from "../game/notation.js";

/** How long one stroke takes to draw. Keep in step with `--dur-march` in tokens.css. */
export const DRAW_MS = 600;
/** The gap between two marks of the same act. */
export const STAGGER_MS = 70;
/** A crowded act is not allowed to drag: its stagger is squeezed to fit in this long. */
export const ACT_MAX_MS = 700;
/** How long a failure's stamp takes to land. */
export const STAMP_MS = 360;

export type Act = "stand" | "move";

/** Which act a mark belongs to. */
export function actOf(text: string): Act {
  const o = parseOrder(text);
  return o?.type === "move" || o?.type === "retreat" ? "move" : "stand";
}

export interface MarkTiming {
  /** When the mark starts to draw. */
  delay: number;
  /** When its failure stamp lands, if it failed. */
  stamp: number;
}

export interface ResultsTiming {
  marks: MarkTiming[];
  /** When the standoff hatching fades in (it takes `STAMP_MS`). */
  standoffs: number;
  /** When the last thing has finished moving. */
  total: number;
}

/** The running order for a phase's order marks, in the order they are given. */
export function resultsTiming(orders: readonly { text: string; ok?: boolean | undefined }[]): ResultsTiming {
  const acts: Act[] = ["stand", "move"];
  const counts = { stand: 0, move: 0 } as Record<Act, number>;
  for (const o of orders) counts[actOf(o.text)]++;
  // Each act starts once the previous one has had time to draw its first strokes.
  const start: Record<Act, number> = { stand: 0, move: 0 };
  let t = 0;
  for (const act of acts) {
    start[act] = t;
    if (counts[act] > 0) t += Math.min(ACT_MAX_MS, gap(counts[act]) * (counts[act] - 1)) + DRAW_MS * 0.6;
  }
  const seen = { stand: 0, move: 0 } as Record<Act, number>;
  let total = 0;
  const marks = orders.map((o) => {
    const act = actOf(o.text);
    const delay = Math.round(start[act] + gap(counts[act]) * seen[act]++);
    const stamp = delay + DRAW_MS;
    total = Math.max(total, o.ok === false ? stamp + STAMP_MS : delay + DRAW_MS);
    return { delay, stamp };
  });
  // Standoffs wash in with the last stamps, so they finish together.
  return { marks, standoffs: Math.max(0, Math.round(total - STAMP_MS)), total };
}

function gap(count: number): number {
  return count > 1 ? Math.min(STAGGER_MS, ACT_MAX_MS / (count - 1)) : 0;
}

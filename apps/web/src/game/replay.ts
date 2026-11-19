/**
 * Playing the phase history back, like a film of the table: each resolved phase is shown long
 * enough for its results to ink in (map/motion.ts) and to be read, then the next, until the
 * game is back at the live phase. Positions are the stepper's: an index into the history, or
 * `null` for the live phase. Pure, so the timing and the order are unit tested.
 */

export const SPEEDS = [0.5, 1, 2] as const;
export type Speed = (typeof SPEEDS)[number];

/** How long a phase stays on screen once its marks have settled, at 1x. */
export const READ_MS = 1400;

/** How long playback stays on one phase: its results drawing, then time to read them. */
export function dwell(animationMs: number, speed: Speed, reducedMotion: boolean): number {
  return Math.round(((reducedMotion ? 0 : animationMs) + READ_MS) / speed);
}

/** Where Play starts: from the first phase when the live phase is shown, else where the player is. */
export function playFrom(viewing: number | null, length: number): number | null {
  if (length === 0) return null;
  return viewing === null || viewing >= length ? 0 : viewing;
}

/** The position after `viewing`: the next phase, then the live one. */
export function advance(viewing: number, length: number): number | null {
  return viewing + 1 < length ? viewing + 1 : null;
}

/** How a speed is written on its button and read out. */
export function speedLabel(speed: Speed): { short: string; long: string } {
  return speed === 0.5 ? { short: "½×", long: "Half speed" } : speed === 1 ? { short: "1×", long: "Normal speed" } : { short: "2×", long: "Double speed" };
}

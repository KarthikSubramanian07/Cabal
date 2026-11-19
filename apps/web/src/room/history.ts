/**
 * A live game's phase records, in the sandbox's own shape (`PhaseRecord`), so the results list,
 * the board's result arrows and the replay scrubber are the sandbox's, unchanged.
 *
 * Two sources: the server's MILA saved game (`GET /api/games/:id/replay`), which has the whole
 * history and survives a reload, and the `results` frames this device saw arrive, which are on
 * screen the moment a phase resolves, before any request could return.
 */
import type { PhaseOutcome, State } from "../engine.js";
import { bookFromSaved, type PhaseRecord, loadSaved, tidyOutcome } from "../game/saved.js";
import type { ResolvedPhase } from "../lobby/room.js";

/** A phase record from a `results` frame. Null when this device did not see the phase begin. */
export function recordFromFrame(resolved: ResolvedPhase): PhaseRecord | null {
  const before = resolved.before as unknown as State | null;
  if (!before) return null;
  const byPower: Record<string, string[]> = {};
  for (const r of resolved.results) (byPower[r.power] ??= []).push(r.order);
  const outcome = tidyOutcome({
    phase: resolved.phase,
    results: resolved.results,
    dislodged: resolved.dislodged,
    standoffs: resolved.standoffs,
    civil_disorder: resolved.civil_disorder,
    // The frame does not carry the position after the phase; nothing on screen reads it.
    next: before,
  } as unknown as PhaseOutcome);
  return { phase: resolved.phase, state: before, orders: bookFromSaved(byPower, resolved.phase, before), outcome };
}

/** Phase records from the server's saved game. Throws when the text is not one. */
export function recordsFromReplay(json: string): PhaseRecord[] {
  return loadSaved(json).history;
}

/**
 * One list, oldest first: the saved game's records, then any phase this device saw resolve that
 * the saved game did not have yet. `order` is the history's phase names in order.
 */
export function mergeRecords(saved: readonly PhaseRecord[], frames: Record<string, ResolvedPhase>, order: readonly string[]): PhaseRecord[] {
  const byPhase = new Map(saved.map((r) => [r.phase, r]));
  for (const resolved of Object.values(frames)) {
    if (byPhase.has(resolved.phase)) continue;
    const record = recordFromFrame(resolved);
    if (record) byPhase.set(record.phase, record);
  }
  const rank = new Map(order.map((p, i) => [p, i]));
  return [...byPhase.values()].sort((a, b) => (rank.get(a.phase) ?? Infinity) - (rank.get(b.phase) ?? Infinity));
}

/**
 * Phases in the history that neither the saved game nor this device's frames can draw. The saved
 * game is fetched only while some are missing (on arrival, or after a gap in the connection), not
 * again at every phase by every seat and spectator.
 */
export function missingPhases(saved: readonly PhaseRecord[], frames: Record<string, ResolvedPhase>, order: readonly string[]): string[] {
  const have = new Set(saved.map((r) => r.phase));
  return order.filter((phase) => !have.has(phase) && !frames[phase]?.before);
}

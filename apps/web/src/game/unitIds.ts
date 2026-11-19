/**
 * Stable identities for units. The engine names a unit by where it stands (`A PAR`), so
 * the army that marches from Paris to Burgundy is, by name, a different unit next phase.
 * Drawing code needs to know it is the same piece, so it can be moved rather than swapped.
 *
 * `trackUnits` walks the phase history and gives every unit an id that follows it through
 * moves, retreats and dislodgement, from its first appearance until it is destroyed.
 */
import type { PhaseOutcome, State } from "../engine.js";
import { parseOrder, parseUnit, provinceOf } from "./notation.js";

/** Ids for one board position, keyed by `POWER|unit text as the state writes it` (`FRANCE|A PAR`, `AUSTRIA|*F TRI`). */
export type UnitIds = Record<string, string>;

export const unitKey = (power: string, unit: string): string => `${power}|${unit}`;

interface Tracker {
  ids: UnitIds;
  next: number;
}

function fresh(tracker: Tracker, power: string): string {
  tracker.next += 1;
  return `${power.toLowerCase()}-${tracker.next}`;
}

/** Ids for a position nothing is known about: every unit is new. */
function seed(state: State, tracker: Tracker): UnitIds {
  const ids: UnitIds = {};
  for (const power of Object.keys(state.units).sort()) {
    for (const unit of state.units[power] ?? []) ids[unitKey(power, unit)] = fresh(tracker, power);
  }
  return ids;
}

/**
 * Carry ids from the position before a phase to the position after it.
 * A successful move or retreat takes the id to the destination; a unit that stays keeps it;
 * anything in `after` that nothing arrived at or stayed in is a new build.
 */
function advance(before: State, beforeIds: UnitIds, outcome: PhaseOutcome, after: State, tracker: Tracker): UnitIds {
  /** `POWER|PROVINCE` -> id, for units that end the phase where they began. */
  const stayers = new Map<string, string>();
  /** `POWER|PROVINCE` -> id, for units that successfully moved or retreated in. */
  const arrivals = new Map<string, string>();

  const moved = new Map<string, string>();
  for (const r of outcome.results) {
    if (!r.ok) continue;
    const o = parseOrder(r.order);
    if (o?.type === "move" || o?.type === "retreat") moved.set(`${r.power}|${o.unit.province}`, provinceOf(o.dest));
  }

  for (const [power, units] of Object.entries(before.units)) {
    for (const unit of units) {
      const ref = parseUnit(unit);
      const id = beforeIds[unitKey(power, unit)];
      if (!ref || !id) continue;
      const dislodged = unit.startsWith("*");
      const dest = moved.get(`${power}|${ref.province}`);
      // In a retreat phase only the dislodged units move; a standing unit in the same province stays.
      const canMove = dest !== undefined && (outcome.phase.endsWith("R") ? dislodged : !dislodged);
      if (canMove) arrivals.set(`${power}|${dest}`, id);
      else if (!dislodged) stayers.set(`${power}|${ref.province}`, id);
    }
  }

  const ids: UnitIds = {};
  for (const power of Object.keys(after.units).sort()) {
    for (const unit of after.units[power] ?? []) {
      const ref = parseUnit(unit);
      if (!ref) continue;
      const at = `${power}|${ref.province}`;
      const id = unit.startsWith("*") ? stayers.get(at) : (arrivals.get(at) ?? stayers.get(at));
      ids[unitKey(power, unit)] = id ?? fresh(tracker, power);
    }
  }
  return ids;
}

export interface TrackedHistory {
  /** Ids for the position each recorded phase began with, in order. */
  phases: UnitIds[];
  /** Ids for the position now on the board. */
  live: UnitIds;
}

/**
 * Ids for a whole game. Deterministic: the same history always yields the same ids, so an
 * undo, a reload or an import keeps every surviving piece's identity.
 */
export function trackUnits(history: readonly { state: State; outcome: PhaseOutcome }[], live: State): TrackedHistory {
  const tracker: Tracker = { ids: {}, next: 0 };
  const phases: UnitIds[] = [];
  let current: UnitIds | null = null;
  history.forEach((record, i) => {
    current ??= seed(record.state, tracker);
    phases.push(current);
    const after = history[i + 1]?.state ?? live;
    current = advance(record.state, current, record.outcome, after, tracker);
  });
  return { phases, live: current ?? seed(live, tracker) };
}

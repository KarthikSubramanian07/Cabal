/**
 * The game as a timeline: one mark per resolved phase with what happened in it, for the
 * replay scrubber. Pure, from the same phase records the sandbox keeps and a replay page
 * fetches (`state` before, `outcome` with `next` after), so it is unit tested and shared.
 */
import type { PhaseOutcome, State } from "@cabal/engine";
import { type PhaseKind, describePhase, parseOrder, phaseKind, titleCase } from "../game/notation.js";

export interface PhaseEvents {
  /** Supply centres that changed hands. */
  captures: number;
  /** Units beaten out of their province. */
  dislodged: number;
  /** Provinces nobody got into. */
  standoffs: number;
  builds: number;
  disbands: number;
  /** Powers left with no units and no centres. */
  eliminated: string[];
  /** Set when the phase ended the game: `solo:FRANCE` or `draw`. */
  ended: string | null;
}

/** The one thing a phase is remembered by on the timeline, if anything. */
export type Headline = "eliminated" | "ended" | "dislodged" | "captures" | "builds" | "disbands" | "standoffs" | null;

export interface PhaseMark {
  phase: string;
  kind: PhaseKind;
  season: string;
  year: string;
  events: PhaseEvents;
  headline: Headline;
  /** The events in words, for the scrubber's spoken value. Empty for a quiet phase. */
  summary: string;
}

export interface TimelineRecord {
  phase: string;
  state: State;
  outcome: PhaseOutcome;
}

function owners(state: State): Map<string, string> {
  const m = new Map<string, string>();
  for (const [power, centres] of Object.entries(state.centers ?? {})) for (const c of centres) m.set(c, power);
  return m;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function phaseEvents(record: TimelineRecord): PhaseEvents {
  const before = owners(record.state);
  const after = owners(record.outcome.next);
  let captures = 0;
  for (const [centre, power] of after) if (before.get(centre) !== power) captures++;
  let builds = 0;
  let disbands = 0;
  for (const r of record.outcome.results) {
    if (!r.ok) continue;
    const o = parseOrder(r.order);
    if (o?.type === "build") builds++;
    if (o?.type === "disband" && phaseKind(record.phase) === "A") disbands++;
  }
  const alive = (s: State, p: string) => (s.units[p]?.length ?? 0) > 0 || (s.centers[p]?.length ?? 0) > 0;
  const eliminated = Object.keys(record.state.units)
    .filter((p) => alive(record.state, p) && !alive(record.outcome.next, p))
    .sort();
  const status = record.outcome.status;
  return {
    captures,
    dislodged: record.outcome.dislodged.length,
    standoffs: record.outcome.standoffs.length,
    builds,
    disbands,
    eliminated,
    ended: status && status !== "active" ? status : null,
  };
}

export function headlineOf(e: PhaseEvents): Headline {
  if (e.ended) return "ended";
  if (e.eliminated.length) return "eliminated";
  if (e.dislodged) return "dislodged";
  if (e.captures) return "captures";
  if (e.builds) return "builds";
  if (e.disbands) return "disbands";
  if (e.standoffs) return "standoffs";
  return null;
}

export function summarise(e: PhaseEvents): string {
  const parts: string[] = [];
  if (e.ended) parts.push(e.ended.startsWith("solo:") ? `${titleCase(e.ended.slice(5))} wins` : "the game is drawn");
  for (const p of e.eliminated) parts.push(`${titleCase(p)} eliminated`);
  if (e.dislodged) parts.push(`${plural(e.dislodged, "unit", "units")} dislodged`);
  if (e.captures) parts.push(`${plural(e.captures, "centre", "centres")} changed hands`);
  if (e.builds) parts.push(`${plural(e.builds, "build", "builds")}`);
  if (e.disbands) parts.push(`${plural(e.disbands, "disband", "disbands")}`);
  if (e.standoffs) parts.push(`${plural(e.standoffs, "standoff", "standoffs")}`);
  return parts.join(", ");
}

/** The marks for a whole game, oldest first. */
export function timeline(history: readonly TimelineRecord[]): PhaseMark[] {
  return history.map((record) => {
    const events = phaseEvents(record);
    const { season, year } = describePhase(record.phase);
    return { phase: record.phase, kind: phaseKind(record.phase), season, year, events, headline: headlineOf(events), summary: summarise(events) };
  });
}

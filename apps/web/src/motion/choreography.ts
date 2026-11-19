/**
 * The choreography of one resolved phase: who moves where, when, and what is heard. A phase
 * is told on the table in four beats, like an umpire reading the orders aloud:
 *
 * 1. Stand. The units that hold, support and convoy are inked in, one after the other.
 * 2. March. Each move is drawn and its piece marches along its own arrow. A move that fails
 *    gets a third of the way, meets resistance and recoils to where it began.
 * 3. Impact. A unit beaten out of its province is knocked aside as its attacker arrives.
 * 4. Verdict. Every failure is stamped, the standoffs wash in. Retreats and builds stamp in
 *    here too; disbanded units fade from the board.
 *
 * Pure numbers and points: the board turns the frames into Web Animations, the sound deck
 * turns the cues into noises, and the tests read both without a browser. Under reduced motion
 * nothing travels: the old position dissolves into the new one in under half a second.
 */
import type { OrderResult, State } from "@cabal/engine";
import { type PhaseKind, parseOrder, parseUnit, phaseKind } from "../game/notation.js";
import { type UnitIds, unitKey } from "../game/unitIds.js";
import type { Point } from "../map/boardData.js";
import { type Track, convoyedArrow, moveArrow, trackPoint } from "../map/geometry.js";
import type { Cue } from "../sound/cues.js";

/** How long one stroke of ink takes to draw. Keep in step with `--dur-march` in tokens.css. */
export const DRAW_MS = 600;
/** The gap between two marks of the same beat. */
export const STAGGER_MS = 70;
/** A crowded beat is squeezed to fit in this long. */
export const ACT_MAX_MS = 700;
/** The piece sets off this long after its arrow starts to draw: the ink leads. */
export const LEAD_MS = 140;
/** A march from one province to the next. */
export const MARCH_MS = 760;
/** How far along its arrow a failed move gets before it recoils. */
export const BOUNCE_REACH = 0.36;
/** Being knocked out of a province. */
export const KNOCK_MS = 320;
/** The pause between the last impact and the first stamp. */
export const VERDICT_GAP_MS = 140;
/** The gap between two stamps; a long list is squeezed into `STAMPS_MAX_MS`. */
export const STAMP_GAP_MS = 90;
export const STAMPS_MAX_MS = 600;
/** How long a stamp takes to land. Keep in step with the stamp-thud keyframes. */
export const STAMP_MS = 360;
/** A disbanded unit fading out, a built one landing. */
export const FADE_MS = 420;
export const BUILD_MS = 320;
/** The whole of a reduced-motion phase: a dissolve, no travel. */
export const DISSOLVE_MS = 420;

export interface Frame {
  /** Milliseconds from the start of the phase. */
  t: number;
  x: number;
  y: number;
  opacity?: number;
  scale?: number;
}

export type Role = "still" | "march" | "bounce" | "knocked" | "retreat" | "disband" | "build";

export interface UnitTrack {
  /** Stable id (unitIds.ts), the piece's key on the board. */
  id: string;
  power: string;
  kind: "A" | "F";
  /** Where the piece stands once the phase has played. */
  end: Point;
  /** The region it ends on (or left from, for a piece that is gone). */
  region: string;
  /** Drawn as dislodged once the phase has played. */
  dislodged: boolean;
  /** It stood dislodged as the phase began: a retreat phase's units, the ones its orders are for. */
  wasDislodged: boolean;
  /** When a piece that ends dislodged turns so (its dashed vermilion outline). */
  turnsAt?: number;
  /** The piece leaves the board (disbanded or destroyed) and is hidden at the end. */
  gone: boolean;
  role: Role;
  /** Absolute frames; empty for a piece that never moves. */
  frames: Frame[];
  /** The unit as written before the phase, for its tooltip. */
  unit: string;
}

export interface MarkTiming {
  /** When the mark starts to draw. */
  delay: number;
  /** When its failure stamp lands, if it failed. */
  stamp: number;
}

export interface Choreography {
  units: UnitTrack[];
  /** One per drawn order, in the order given. */
  marks: MarkTiming[];
  /** When the standoff hatching washes in. */
  standoffs: number;
  /** When the last thing has settled. */
  total: number;
  cues: Cue[];
  /** When each beat begins, for tests and the scrubber. */
  beats: { stand: number; march: number; verdict: number };
}

export interface ResolutionInput {
  phase: string;
  /** The board as the phase began. */
  before: State;
  /** The board once it was adjudicated (`outcome.next`). */
  after: State;
  results: readonly OrderResult[];
  beforeIds?: UnitIds | undefined;
  afterIds?: UnitIds | undefined;
}

export interface Geometry {
  /** Where a piece stands on a region (`PAR`, `STP/NC`). */
  point: (region: string) => Point;
  /** Piece radius in board units, for the dislodged offset and the arrows. */
  r: number;
  /** Moves by convoy: the regions of the fleets carrying them, by order text. */
  routes?: ReadonlyMap<string, readonly string[]> | undefined;
}

/** Where a dislodged piece stands: up and to the right of the province it lost. */
export function standAside(at: Point, r: number): Point {
  return [at[0] + r * 1.15, at[1] - r * 1.15];
}

/**
 * The piece an order's province names, for ringing it on the board. Before a retreat phase a
 * province can hold two units, the one that took it and the one dislodged from it; every order
 * and result of that phase is the dislodged one's, so it wins, even once it is gone (it is then
 * ringed where it stood). Otherwise the one piece that began the phase there.
 */
export function trackAt(plan: Pick<Choreography, "units">, province: string): UnitTrack | undefined {
  const here = plan.units.filter((u) => parseUnit(u.unit)?.province === province);
  if (here.length <= 1) return here[0];
  return here.find((u) => u.wasDislodged) ?? here.find((u) => !u.gone) ?? here[0];
}

/** Which beat a drawn mark belongs to. */
export function beatOf(text: string): "stand" | "move" {
  const o = parseOrder(text);
  return o?.type === "move" || o?.type === "retreat" ? "move" : "stand";
}

function gap(count: number): number {
  return count > 1 ? Math.min(STAGGER_MS, ACT_MAX_MS / (count - 1)) : 0;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Frames for a piece walked along `path` from `from` to `to` (shares of its length) over `ms`. */
function walk(path: Track, start: number, ms: number, from: number, to: number, shape: (t: number) => number, steps = 10): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const [x, y] = trackPoint(path, from + (to - from) * shape(k));
    frames.push({ t: Math.round(start + ms * k), x, y });
  }
  return frames;
}

interface Piece {
  id: string;
  power: string;
  unit: string;
  kind: "A" | "F";
  region: string;
  dislodged: boolean;
}

function piecesOf(state: State, ids: UnitIds | undefined): Map<string, Piece> {
  const out = new Map<string, Piece>();
  for (const power of Object.keys(state.units).sort()) {
    for (const text of state.units[power] ?? []) {
      const ref = parseUnit(text);
      if (!ref) continue;
      const id = ids?.[unitKey(power, text)] ?? `${power}-${text}`;
      out.set(id, { id, power, unit: ref.unit, kind: ref.kind, region: ref.region, dislodged: text.startsWith("*") });
    }
  }
  return out;
}

/**
 * The choreography for one phase. `marks` are the orders the board draws for it (with their
 * results), in the order the board draws them.
 */
export function choreograph(
  input: ResolutionInput,
  marks: readonly { text: string; ok?: boolean | undefined }[],
  geo: Geometry,
  options: { reduced?: boolean } = {},
): Choreography {
  const kind: PhaseKind = phaseKind(input.phase);
  const before = piecesOf(input.before, input.beforeIds);
  const after = piecesOf(input.after, input.afterIds);
  const at = (p: Piece) => (p.dislodged ? standAside(geo.point(p.region), geo.r) : geo.point(p.region));
  if (options.reduced) return dissolve(before, after, marks, at);

  // 1 and 2: the stand beat, then the moves, each staggered and squeezed.
  const counts = { stand: 0, move: 0 };
  for (const m of marks) counts[beatOf(m.text)]++;
  const standStart = 0;
  const marchStart = counts.stand > 0 ? Math.min(ACT_MAX_MS, gap(counts.stand) * (counts.stand - 1)) + DRAW_MS * 0.6 : 0;
  const seen = { stand: 0, move: 0 };
  const delays = marks.map((m) => {
    const beat = beatOf(m.text);
    const base = beat === "stand" ? standStart : marchStart;
    return Math.round(base + gap(counts[beat]) * seen[beat]++);
  });
  const markOf = (order: string) => {
    const i = marks.findIndex((m) => m.text === order);
    return i >= 0 ? delays[i]! : marchStart;
  };

  const resultFor = (p: Piece) =>
    input.results.find((r) => r.power === p.power && parseUnit(r.unit || r.order)?.unit === p.unit);

  const units: UnitTrack[] = [];
  /** When each moving unit lands (or recoils home), by its unit text, for the knock that follows. */
  const lands = new Map<string, number>();
  let lastImpact = marks.length ? Math.max(...delays) + DRAW_MS : 0;
  const pending: { piece: Piece; result: OrderResult | undefined; start: Point }[] = [];

  for (const piece of before.values()) {
    const start = at(piece);
    const result = resultFor(piece);
    const order = result ? parseOrder(result.order) : null;
    const moving = order && (order.type === "move" || order.type === "retreat") && (kind !== "R" || piece.dislodged);
    if (!moving || !result) {
      pending.push({ piece, result, start });
      continue;
    }
    const dest = geo.point(order.dest);
    const route = order.type === "move" && order.via ? geo.routes?.get(result.order) : undefined;
    const path =
      route && route.length
        ? convoyedArrow(start, route.map(geo.point), dest, geo.r).path
        : moveArrow(start, dest, geo.r).path;
    const t0 = markOf(result.order) + LEAD_MS;
    const later = after.get(piece.id);
    if (result.ok && later) {
      const frames = walk(path, t0, MARCH_MS, 0, 1, ease, 12);
      const end = at(later);
      frames[frames.length - 1] = { ...frames.at(-1)!, x: end[0], y: end[1] };
      units.push(track(piece, later, kind === "R" ? "retreat" : "march", end, frames));
      lands.set(piece.unit, t0 + MARCH_MS);
      lastImpact = Math.max(lastImpact, t0 + MARCH_MS);
      continue;
    }
    // Out a third of the way, a beat of resistance, then back with a small overshoot.
    const out = walk(path, t0, MARCH_MS * 0.42, 0, BOUNCE_REACH, easeOut, 6);
    const hold = out.at(-1)!;
    const back = walk(path, t0 + MARCH_MS * 0.5, MARCH_MS * 0.5, BOUNCE_REACH, -0.025, ease, 6).slice(1);
    const home = { t: Math.round(t0 + MARCH_MS + 90), x: start[0], y: start[1] };
    const frames = [...out, { ...hold, t: Math.round(t0 + MARCH_MS * 0.5) }, ...back, home];
    lands.set(piece.unit, home.t);
    lastImpact = Math.max(lastImpact, t0 + MARCH_MS * 0.42);
    pending.push({ piece, result, start });
    units.push(track(piece, later ?? piece, "bounce", later ? at(later) : start, frames, !later));
  }

  const verdict = Math.round(lastImpact + VERDICT_GAP_MS);

  // 3: the units that stayed (or bounced home) and lost their province.
  for (const { piece, result, start } of pending) {
    const later = after.get(piece.id);
    const bounced = units.find((u) => u.id === piece.id);
    if (later && later.dislodged && !piece.dislodged) {
      const attacker = result?.by?.find((u) => lands.has(parseUnit(u)?.unit ?? ""));
      const hit = Math.max(attacker ? lands.get(parseUnit(attacker)!.unit)! : verdict - VERDICT_GAP_MS, bounced ? lands.get(piece.unit)! : 0);
      const end = at(later);
      const over: Point = [start[0] + (end[0] - start[0]) * 1.4, start[1] + (end[1] - start[1]) * 1.4];
      const knock: Frame[] = [
        { t: hit, x: start[0], y: start[1] },
        { t: hit + Math.round(KNOCK_MS * 0.3), x: over[0], y: over[1] },
        { t: hit + KNOCK_MS, x: end[0], y: end[1] },
      ];
      const track_ = track(piece, later, "knocked", end, bounced ? [...bounced.frames.filter((f) => f.t < hit), ...knock] : knock);
      track_.turnsAt = hit;
      if (bounced) units.splice(units.indexOf(bounced), 1);
      units.push(track_);
      lastImpact = Math.max(lastImpact, hit + KNOCK_MS);
      continue;
    }
    if (bounced) continue;
    if (!later) {
      // Disbanded or destroyed: it fades where it stood, once the verdict is read.
      units.push(track(piece, piece, "disband", start, fadeOut(start, verdict), true));
      continue;
    }
    units.push(track(piece, later, "still", at(later), []));
  }
  // A unit that bounced in a retreat and is gone fades where it came back to.
  for (const u of units) {
    if (u.role === "bounce" && u.gone) {
      const home = u.frames.at(-1)!;
      u.frames.push(...fadeOut([home.x, home.y], Math.max(verdict, home.t + 40)));
    }
  }

  // 4: the verdict. Failures stamped in the order they were drawn, standoffs with them.
  const failed = marks.map((m, i) => (m.ok === false ? i : -1)).filter((i) => i >= 0);
  const stampGap = failed.length > 1 ? Math.min(STAMP_GAP_MS, STAMPS_MAX_MS / (failed.length - 1)) : 0;
  const settle = Math.max(verdict, Math.round(lastImpact + VERDICT_GAP_MS));
  const stamps = new Map<number, number>();
  failed.forEach((i, n) => stamps.set(i, Math.round(settle + stampGap * n)));
  const timing: MarkTiming[] = delays.map((delay, i) => ({ delay, stamp: stamps.get(i) ?? delay + DRAW_MS }));

  // New pieces (builds) land with a stamp of their own.
  const builds: number[] = [];
  for (const piece of after.values()) {
    if (before.has(piece.id)) continue;
    const t = Math.round(settle + stampGap * failed.length + builds.length * STAMP_GAP_MS);
    builds.push(t);
    const end = at(piece);
    units.push({
      ...track(piece, piece, "build", end, [
        { t, x: end[0], y: end[1], opacity: 0, scale: 1.9 },
        { t: t + Math.round(BUILD_MS * 0.6), x: end[0], y: end[1], opacity: 1, scale: 0.94 },
        { t: t + BUILD_MS, x: end[0], y: end[1], opacity: 1, scale: 1 },
      ]),
    });
  }

  const lastStamp = Math.max(0, ...stamps.values(), ...builds);
  const lastFrame = Math.max(0, ...units.flatMap((u) => u.frames.map((f) => f.t)));
  const drawn = marks.length ? Math.max(...delays) + DRAW_MS : 0;
  const total = Math.max(drawn, lastFrame, stamps.size || builds.length ? lastStamp + STAMP_MS : 0);
  const standoffs = Math.max(0, Math.round((stamps.size ? lastStamp + STAMP_MS : total) - STAMP_MS));

  const cues: Cue[] = [];
  if (marks.length) cues.push({ at: 0, sound: "crack" });
  if (counts.stand > 0) cues.push({ at: 40, sound: "quill" });
  let lastMarch = Number.NEGATIVE_INFINITY;
  for (const u of [...units].sort((a, b) => (a.frames[0]?.t ?? 0) - (b.frames[0]?.t ?? 0))) {
    if (u.role !== "march" && u.role !== "retreat" && u.role !== "bounce") continue;
    const t = u.frames[0]?.t ?? 0;
    if (t - lastMarch < 280) continue;
    lastMarch = t;
    if (cues.filter((c) => c.sound === "march").length < 3) cues.push({ at: t, sound: "march" });
  }
  for (const u of units) if (u.role === "knocked" && u.turnsAt !== undefined) cues.push({ at: u.turnsAt, sound: "thud", weight: 1.4 });
  [...stamps.values(), ...builds].slice(0, 6).forEach((t) => cues.push({ at: t + 60, sound: "thud" }));
  if (total > 0) cues.push({ at: total, sound: "tick" });
  cues.sort((a, b) => a.at - b.at);

  return { units, marks: timing, standoffs, total, cues, beats: { stand: standStart, march: marchStart, verdict: settle } };
}

function fadeOut(at: Point, t: number): Frame[] {
  return [
    { t, x: at[0], y: at[1], opacity: 1, scale: 1 },
    { t: t + FADE_MS, x: at[0], y: at[1] + 3, opacity: 0, scale: 0.7 },
  ];
}

function track(piece: Piece, later: Piece, role: Role, end: Point, frames: Frame[], gone = false): UnitTrack {
  return {
    id: piece.id,
    power: piece.power,
    kind: piece.kind,
    end,
    region: gone ? piece.region : later.region,
    dislodged: later.dislodged,
    wasDislodged: piece.dislodged,
    gone,
    role,
    frames,
    unit: piece.unit,
  };
}

/** Reduced motion: every mark simply appears, and each moved piece dissolves into its new place. */
function dissolve(
  before: Map<string, Piece>,
  after: Map<string, Piece>,
  marks: readonly { text: string; ok?: boolean | undefined }[],
  at: (p: Piece) => Point,
): Choreography {
  const half = DISSOLVE_MS / 2;
  const units: UnitTrack[] = [];
  for (const piece of before.values()) {
    const start = at(piece);
    const later = after.get(piece.id);
    if (!later) {
      units.push(track(piece, piece, "disband", start, [
        { t: 0, x: start[0], y: start[1], opacity: 1 },
        { t: DISSOLVE_MS, x: start[0], y: start[1], opacity: 0 },
      ], true));
      continue;
    }
    const end = at(later);
    const moved = Math.hypot(end[0] - start[0], end[1] - start[1]) > 0.5;
    units.push(
      track(piece, later, moved ? (later.dislodged ? "knocked" : "march") : "still", end, moved
        ? [
            { t: 0, x: start[0], y: start[1], opacity: 1 },
            { t: half, x: start[0], y: start[1], opacity: 0 },
            { t: half, x: end[0], y: end[1], opacity: 0 },
            { t: DISSOLVE_MS, x: end[0], y: end[1], opacity: 1 },
          ]
        : []),
    );
  }
  for (const piece of after.values()) {
    if (before.has(piece.id)) continue;
    const end = at(piece);
    units.push(track(piece, piece, "build", end, [
      { t: 0, x: end[0], y: end[1], opacity: 0 },
      { t: DISSOLVE_MS, x: end[0], y: end[1], opacity: 1 },
    ]));
  }
  const failed = marks.some((m) => m.ok === false);
  const cues: Cue[] = marks.length ? [{ at: 0, sound: "crack" }] : [];
  if (failed) cues.push({ at: half, sound: "thud" });
  return {
    units,
    marks: marks.map(() => ({ delay: 0, stamp: 0 })),
    standoffs: 0,
    total: DISSOLVE_MS,
    cues,
    beats: { stand: 0, march: 0, verdict: 0 },
  };
}

/** How long a phase takes to play, without any geometry: for a replay's dwell. */
export function resolutionLength(
  input: ResolutionInput,
  marks: readonly { text: string; ok?: boolean | undefined }[],
  reduced = false,
): number {
  return choreograph(input, marks, { point: () => [0, 0], r: 9 }, { reduced }).total;
}

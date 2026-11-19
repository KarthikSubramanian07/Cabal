/**
 * Order arrows drawn the way a printed Diplomacy map draws them: moves as gently curved
 * strokes with a barbed head, supports as dashed lines that bend in to the middle of the move
 * they back (or to a ring round the unit they hold up), convoys as dotted lines to the army's
 * crossing, holds as rings. Every size is a multiple of the piece radius `r`, which the board
 * picks for the zoom, so the marks read the same at every zoom.
 *
 * Pure: points in, path data out. The board renders it; the motion module walks units along
 * the same tracks, so a marching piece follows the ink of its own arrow.
 */
import type { Point } from "./boardData.js";

/** A quadratic Bézier: start, control, end. */
export interface Quad {
  a: Point;
  c: Point;
  b: Point;
}

/** How far a move bows out of the straight line, as a share of its length. */
export const MOVE_BEND = 0.13;
/** Supports and convoys bow less: they are helpers, not the event. */
export const HELPER_BEND = 0.08;
/** Long arrows would bow out a long way; the bow is capped in board units. */
export const MAX_BOW = 26;

const round = (n: number) => Math.round(n * 10) / 10;
const fmt = (p: Point) => `${round(p[0])} ${round(p[1])}`;

export const lerp = (p: Point, q: Point, t: number): Point => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
export const dist = (p: Point, q: Point): number => Math.hypot(q[0] - p[0], q[1] - p[1]);

/**
 * The curve from `a` to `b` bowed to the left of the direction of travel. Always the same
 * side, so two units swapping places (or bouncing head to head) draw two separate arcs.
 */
export function bowed(a: Point, b: Point, bend = MOVE_BEND): Quad {
  const len = dist(a, b) || 1;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  const bow = Math.min(len * bend, MAX_BOW);
  const m = lerp(a, b, 0.5);
  return { a, c: [m[0] + uy * bow, m[1] - ux * bow], b };
}

export function quadPoint(q: Quad, t: number): Point {
  const u = 1 - t;
  return [u * u * q.a[0] + 2 * u * t * q.c[0] + t * t * q.b[0], u * u * q.a[1] + 2 * u * t * q.c[1] + t * t * q.b[1]];
}

/** Unit tangent at `t`. */
export function quadTangent(q: Quad, t: number): Point {
  const dx = 2 * (1 - t) * (q.c[0] - q.a[0]) + 2 * t * (q.b[0] - q.c[0]);
  const dy = 2 * (1 - t) * (q.c[1] - q.a[1]) + 2 * t * (q.b[1] - q.c[1]);
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/** The part of a curve between `t0` and `t1` (de Casteljau), itself a quadratic. */
export function quadSlice(q: Quad, t0: number, t1: number): Quad {
  // The curve up to t1, then the part of that from t0 on.
  const left: Quad = { a: q.a, c: lerp(q.a, q.c, t1), b: quadPoint(q, t1) };
  const s = t1 > 0 ? t0 / t1 : 0;
  return { a: quadPoint(left, s), c: lerp(left.c, left.b, s), b: left.b };
}

/** Rough arc length, plenty for trimming and walking. */
export function quadLength(q: Quad, steps = 16): number {
  let len = 0;
  let prev = q.a;
  for (let i = 1; i <= steps; i++) {
    const p = quadPoint(q, i / steps);
    len += dist(prev, p);
    prev = p;
  }
  return len;
}

/** The curve with `start` and `end` board units taken off its ends. */
export function trim(q: Quad, start: number, end: number): Quad {
  const len = quadLength(q) || 1;
  const t0 = Math.min(0.45, Math.max(0, start / len));
  const t1 = Math.max(0.55, Math.min(1, 1 - end / len));
  return quadSlice(q, t0, t1);
}

export function quadPath(q: Quad): string {
  return `M${fmt(q.a)} Q${fmt(q.c)} ${fmt(q.b)}`;
}

/**
 * A barbed arrowhead with its tip at `tip`, pointing along `dir` (a unit vector): tip, wing,
 * notch, wing. `size` is the length from tip to wing.
 */
export function arrowHead(tip: Point, dir: Point, size: number): string {
  const [ux, uy] = dir;
  const half = size * 0.56;
  const back: Point = [tip[0] - ux * size, tip[1] - uy * size];
  const notch: Point = [tip[0] - ux * size * 0.66, tip[1] - uy * size * 0.66];
  const left: Point = [back[0] + uy * half, back[1] - ux * half];
  const right: Point = [back[0] - uy * half, back[1] + ux * half];
  return [tip, left, notch, right].map((p) => `${round(p[0])},${round(p[1])}`).join(" ");
}

/** Sizes of the marks for a piece radius. */
export function markSizes(r: number) {
  return {
    head: Math.max(7, r * 1.02),
    /** Room left at the origin so the stroke starts at the edge of the piece. */
    leave: r + 2,
    /** The tip stops short of the destination's centre so the piece there stays readable. */
    arrive: r * 0.45,
    ring: r + 4.5,
    knot: Math.max(2.4, r * 0.34),
  };
}

/** A path a piece can be walked along: a chain of curves, measured by length. */
export interface Track {
  segments: Quad[];
  lengths: number[];
  length: number;
}

export function track(segments: Quad[]): Track {
  const lengths = segments.map((s) => quadLength(s));
  return { segments, lengths, length: lengths.reduce((a, b) => a + b, 0) };
}

/** The point `t` (0 to 1) of the way along a track, by distance travelled. */
export function trackPoint(tr: Track, t: number): Point {
  if (tr.segments.length === 0) return [0, 0];
  let want = Math.max(0, Math.min(1, t)) * tr.length;
  for (let i = 0; i < tr.segments.length; i++) {
    const len = tr.lengths[i]!;
    if (want <= len || i === tr.segments.length - 1) {
      const s = tr.segments[i]!;
      // Walk the segment by length rather than by its parameter, so the pace is even.
      const steps = 16;
      let acc = 0;
      let prev = s.a;
      for (let k = 1; k <= steps; k++) {
        const p = quadPoint(s, k / steps);
        const d = dist(prev, p);
        if (acc + d >= want) return lerp(prev, p, d ? (want - acc) / d : 0);
        acc += d;
        prev = p;
      }
      return s.b;
    }
    want -= len;
  }
  return tr.segments.at(-1)!.b;
}

/**
 * The curves of a move carried by convoy: from the army through each carrying fleet to the
 * landing, bent at every fleet so the crossing reads as one stroke.
 */
export function convoySegments(points: readonly Point[]): Quad[] {
  if (points.length < 2) return [];
  if (points.length === 2) return [bowed(points[0]!, points[1]!, 0)];
  const segs: Quad[] = [];
  let start = points[0]!;
  for (let i = 1; i < points.length - 1; i++) {
    const c = points[i]!;
    const n = points[i + 1]!;
    const end = i === points.length - 2 ? n : lerp(c, n, 0.5);
    segs.push({ a: start, c, b: end });
    start = end;
  }
  return segs;
}

export function segmentsPath(segs: readonly Quad[]): string {
  if (segs.length === 0) return "";
  return `M${fmt(segs[0]!.a)}${segs.map((s) => ` Q${fmt(s.c)} ${fmt(s.b)}`).join("")}`;
}

export interface MoveArrow {
  /** The stroke, stopping at the head's notch. */
  d: string;
  /** The head's polygon. */
  head: string;
  /** The drawn curve (trimmed), for helpers that aim at its middle. */
  drawn: Quad;
  /** Where a failure is stamped. */
  failAt: Point;
  /** Centre to centre, for a piece to march along. */
  path: Track;
}

/** A move (or retreat) from the centre `from` to the centre `to`. */
export function moveArrow(from: Point, to: Point, r: number): MoveArrow {
  const s = markSizes(r);
  const full = bowed(from, to);
  const drawn = trim(full, s.leave, s.arrive);
  // The stroke ends inside the head so its round cap never shows past the tip.
  const stroke = trim(drawn, 0, s.head * 0.6);
  const tangent = quadTangent(drawn, 1);
  return {
    d: quadPath(stroke),
    head: arrowHead(drawn.b, tangent, s.head),
    drawn,
    failAt: quadPoint(drawn, 0.55),
    path: track([full]),
  };
}

/** A move by convoy through the regions' points `via` (in order), from `from` to `to`. */
export function convoyedArrow(from: Point, via: readonly Point[], to: Point, r: number): MoveArrow {
  const s = markSizes(r);
  const full = convoySegments([from, ...via, to]);
  const first = full[0]!;
  const last = full.at(-1)!;
  const segs = full.map((q, i) => {
    let out = q;
    if (i === 0) out = trim(out, s.leave, 0);
    if (i === full.length - 1) out = trim(out, 0, s.arrive);
    return out;
  });
  const end = segs.at(-1)!;
  const stroke = [...segs.slice(0, -1), trim(end, 0, s.head * 0.6)];
  return {
    d: segmentsPath(stroke),
    head: arrowHead(end.b, quadTangent(end, 1), s.head),
    drawn: segs.length === 1 ? segs[0]! : { a: first.a, c: lerp(first.a, last.b, 0.5), b: last.b },
    failAt: quadPoint(end, 0.5),
    path: track(full),
  };
}

export interface HelperArrow {
  d: string;
  /** The knot at the end of a support or convoy: a shape, so it does not rely on colour. */
  knot: { at: Point; r: number };
  failAt: Point;
}

/**
 * A support for a move: a line from the supporter bending in to the middle of the move it
 * backs (`move` is that move's drawn curve, real or as it would be drawn).
 */
export function supportMoveArrow(from: Point, move: Quad, r: number): HelperArrow {
  const s = markSizes(r);
  const aim = quadPoint(move, 0.5);
  const q = trim(bowed(from, aim, HELPER_BEND), s.leave, s.knot);
  return { d: quadPath(q), knot: { at: aim, r: s.knot }, failAt: quadPoint(q, 0.5) };
}

/** A support for a unit holding: a line to the ring round the unit it holds up. */
export function supportHoldArrow(from: Point, held: Point, r: number): HelperArrow {
  const s = markSizes(r);
  const q = trim(bowed(from, held, HELPER_BEND), s.leave, s.ring);
  return { d: quadPath(q), knot: { at: q.b, r: s.knot }, failAt: quadPoint(q, 0.5) };
}

/** A convoy with no route drawn through it: a dotted line to the middle of the army's crossing. */
export function convoyArrow(from: Point, crossing: Quad, r: number): HelperArrow {
  const s = markSizes(r);
  const aim = quadPoint(crossing, 0.5);
  const q = trim(bowed(from, aim, HELPER_BEND), s.leave, s.knot);
  return { d: quadPath(q), knot: { at: aim, r: s.knot }, failAt: quadPoint(q, 0.5) };
}

/**
 * Board view maths: what part of the map a frame of a given shape shows, how it zooms and
 * pans, and how big labels and pieces are drawn at that zoom. Pure, so it is unit tested;
 * Board.tsx only wires it to pointers and SVG.
 *
 * Board units are the coordinates of board.json (the classic map is 1200 wide). `scale` is
 * CSS pixels per board unit.
 */
import type { Point } from "./boardData.js";

export interface Size {
  w: number;
  h: number;
}

export interface Box extends Size {
  x: number;
  y: number;
}

/**
 * The smallest scale at which province codes are comfortable to read. A frame that cannot
 * show the whole board at this scale (a phone) opens on one theatre of it instead.
 */
export const READABLE_SCALE = 0.62;

/**
 * Below this scale the whole board is too small to play on, so the frame opens zoomed in on
 * the active power at the readable scale: one theatre of the map on a phone. Between the two
 * scales the whole board is shown, a little small. A 1280x720 or 1366x768 laptop gives the
 * board about 0.49 and 0.53, and a Diplomacy board that opens with Russia and Turkey off
 * screen is not one a desktop player expects, so those show all of it.
 */
export const WHOLE_BOARD_MIN_SCALE = 0.48;

/** How far in the view can zoom, as a fraction of the board's width. */
const MIN_VIEW_FRACTION = 1 / 8;

const clampNumber = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The view that shows the whole board in a frame of this shape, centred, with nothing cut off. */
export function wholeView(board: Size, frame: Size): Box {
  const aspect = frame.w / frame.h;
  const w = Math.max(board.w, board.h * aspect);
  const h = w / aspect;
  return { x: (board.w - w) / 2, y: (board.h - h) / 2, w, h };
}

/** Keep a view the frame's shape, inside the zoom limits, and over the board. */
export function clampView(board: Size, frame: Size, box: Box): Box {
  const whole = wholeView(board, frame);
  const w = clampNumber(box.w, board.w * MIN_VIEW_FRACTION, whole.w);
  const h = (w * frame.h) / frame.w;
  // Keep the centre when the width was clamped.
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const along = (centre: number, size: number, limit: number) =>
    size >= limit ? (limit - size) / 2 : clampNumber(centre - size / 2, 0, limit - size);
  return { x: along(cx, w, board.w), y: along(cy, h, board.h), w, h };
}

/** Zoom by `factor` about a board point (the view's centre when none is given). */
export function zoomView(board: Size, frame: Size, box: Box, factor: number, at?: Point): Box {
  const px = at?.[0] ?? box.x + box.w / 2;
  const py = at?.[1] ?? box.y + box.h / 2;
  const whole = wholeView(board, frame);
  const w = clampNumber(box.w / factor, board.w * MIN_VIEW_FRACTION, whole.w);
  const h = (w * frame.h) / frame.w;
  // The point under the cursor stays under the cursor.
  const x = px - ((px - box.x) * w) / box.w;
  const y = py - ((py - box.y) * h) / box.h;
  return clampView(board, frame, { x, y, w, h });
}

export function isWholeView(board: Size, frame: Size, box: Box): boolean {
  return box.w >= wholeView(board, frame).w - 0.5;
}

/** Whether the whole board is playable in this frame, or the frame should open zoomed in. */
export function fitsWhole(board: Size, frame: Size): boolean {
  return frame.w / wholeView(board, frame).w >= WHOLE_BOARD_MIN_SCALE;
}

/**
 * The view a frame opens on. Big frames show the whole board. Small ones show the theatre
 * around `focus` (the active power's units and centres) at a readable scale.
 */
export function homeView(board: Size, frame: Size, focus: readonly Point[]): Box {
  if (fitsWhole(board, frame) || focus.length === 0) return wholeView(board, frame);
  const xs = focus.map((p) => p[0]);
  const ys = focus.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const w = frame.w / READABLE_SCALE;
  const h = frame.h / READABLE_SCALE;
  return clampView(board, frame, { x: cx - w / 2, y: cy - h / 2, w, h });
}

/**
 * Province code size in board units. Ten CSS pixels at the readable scale, growing gently
 * as the player zooms in, without ever swamping a small province. The cap of 16 board units
 * is as large as a code can be before it covers pieces in Italy and the Low Countries, so a
 * whole board on a short laptop screen has codes of about 8 pixels: small, complete, and one
 * zoom step from comfortable.
 */
export function labelSize(scale: number): number {
  const s = Math.max(scale, 0.05);
  const px = 10 * (s / READABLE_SCALE) ** 0.4;
  return clampNumber(px / s, 6, Math.max(LABEL_CAP, MIN_LABEL_PX / s));
}

/**
 * The smallest a province code is drawn, in CSS pixels, however far out a small screen zooms.
 * A whole board on a phone is a quarter of the readable scale, where the cap of 16 board units
 * left codes of four pixels: marks, not words. Seven pixels can still be read, and the layout
 * keeps them off the pieces.
 */
export const MIN_LABEL_PX = 7;

/** The smallest a piece is drawn, as a radius in CSS pixels: big enough to see and to aim at. */
export const MIN_UNIT_PX = 5;

/** Piece radius in board units: about 16 CSS pixels across at the readable scale. */
export function unitRadius(scale: number): number {
  const s = Math.max(scale, 0.05);
  const px = 8 * (s / READABLE_SCALE) ** 0.45;
  return clampNumber(px / s, 6.5, Math.max(UNIT_CAP, MIN_UNIT_PX / s));
}

/** How close, in CSS pixels, a touch must land to a province it can act on to count for it. */
export const TOUCH_REACH_PX = 26;
/** On a far-out overview the reach is capped in board units, so a tap cannot jump provinces away... */
export const TOUCH_REACH_MAX = 48;
/** ...but never below this many CSS pixels, half a comfortable 44-pixel target, at any zoom. */
export const TOUCH_REACH_MIN_PX = 22;

/** How far, in board units, a touch reaches for a province it can act on at this scale. */
export function touchReach(scale: number): number {
  const s = Math.max(scale, 0.05);
  return Math.max(TOUCH_REACH_MIN_PX / s, Math.min(TOUCH_REACH_PX / s, TOUCH_REACH_MAX));
}

/**
 * Where to write a province's code so the piece standing there does not cover it: along the
 * line the map maker chose (below the piece when they coincide), clear of the piece.
 */
export function placeLabel(unit: Point, label: Point, radius: number, size: number): Point {
  const dx = label[0] - unit[0];
  const dy = label[1] - unit[1];
  const dist = Math.hypot(dx, dy);
  const clear = radius * 1.1 + size * 0.62 + 1.5;
  if (dist >= clear) return label;
  const ux = dist < 6 ? 0 : dx / dist;
  const uy = dist < 6 ? 1 : dy / dist;
  return [unit[0] + ux * clear, unit[1] + uy * clear];
}

export interface LabelSpot {
  code: string;
  /** Where the piece stands. */
  unit: Point;
  /** Where the map maker wrote the code. */
  label: Point;
  /** Whether a point lies inside the province. A code should stay in the province it names. */
  inside?: ((point: Point) => boolean) | undefined;
}

/** Roughly how much room a three-letter code takes at a given size. */
function labelBox(at: Point, size: number): { x0: number; y0: number; x1: number; y1: number } {
  const halfW = size * 1.02;
  const halfH = size * 0.45;
  return { x0: at[0] - halfW, y0: at[1] - halfH, x1: at[0] + halfW, y1: at[1] + halfH };
}

function boxHitsCircle(box: ReturnType<typeof labelBox>, c: Point, r: number): boolean {
  const nx = clampNumber(c[0], box.x0, box.x1);
  const ny = clampNumber(c[1], box.y0, box.y1);
  return Math.hypot(c[0] - nx, c[1] - ny) < r;
}

function boxesOverlap(a: ReturnType<typeof labelBox>, b: ReturnType<typeof labelBox>): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Where a code is sampled besides its middle, as fractions of the text size. */
const EDGES = [
  [-0.75, 0],
  [0.75, 0],
  [0, -0.4],
  [0, 0.4],
] as const;

/** Places to try round a piece: how far out (in clearances) and at which angles, in order of preference. */
const RINGS: readonly (readonly [number, readonly number[]])[] = [
  [1, [90, 270, 0, 180, 45, 135, 315, 225, 68, 112, 292, 248, 22, 158, 338, 202]],
  [1.4, [90, 270, 0, 180, 45, 135, 315, 225]],
  [1.9, [90, 270, 0, 180, 45, 135, 315, 225]],
];

/**
 * Place every province code for a piece radius and text size. Each code first tries the
 * side of the piece the map maker chose, then the other sides, and takes the first spot
 * that covers no piece position and no code already placed. Where the map is too crowded
 * for a clean answer (the English Midlands) it takes the least bad one.
 */
export function layoutLabels(
  spots: readonly LabelSpot[],
  radius: number,
  size: number,
  /**
   * Leave out a code that has no spot clear of the codes already placed and of the pieces. For
   * a far-out overview, where every code at a readable size would be a wall of text: the codes
   * that fit are drawn (put the ones that matter first), and zooming in brings the rest.
   */
  options: { drop?: boolean } = {},
): Record<string, Point> {
  const placed: { code: string; box: ReturnType<typeof labelBox> }[] = [];
  const out: Record<string, Point> = {};
  const vertical = radius * 1.1 + size * 0.62 + 1.5;
  const sideways = radius + size * 1.02 + 2;
  for (const spot of spots) {
    const preferred = placeLabel(spot.unit, spot.label, radius, size);
    const [ux, uy] = spot.unit;
    // Below, above and beside first (how a map is usually lettered), then all round the piece,
    // then further out for a long thin province whose near spots fall outside it.
    const candidates: Point[] = [preferred];
    for (const [reach, turns] of RINGS) {
      for (const turn of turns) {
        const a = (turn * Math.PI) / 180;
        candidates.push([ux + Math.cos(a) * sideways * reach, uy + Math.sin(a) * vertical * reach]);
      }
    }
    let best = preferred;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const [i, at] of candidates.entries()) {
      const box = labelBox(at, size);
      let cost = i * 0.004; // earlier candidates win ties
      // Cheapest checks first, and stop as soon as this spot cannot beat the best so far.
      for (const p of placed) if (boxesOverlap(box, p.box)) cost += 1;
      if (cost >= bestCost) continue;
      for (const other of spots) {
        // Fleets are drawn a little wider than the radius.
        if (boxHitsCircle(box, other.unit, radius * 1.2 + 1)) cost += 2;
      }
      if (cost >= bestCost) continue;
      if (spot.inside) {
        // Most of all, a code belongs inside its own province: its middle, and its edges.
        if (!spot.inside(at)) cost += 12;
        for (const [dx, dy] of EDGES) {
          if (cost >= bestCost) break;
          if (!spot.inside([at[0] + dx * size, at[1] + dy * size])) cost += 0.8;
        }
      }
      if (cost < bestCost) {
        best = at;
        bestCost = cost;
        if (cost < 0.5) break;
      }
    }
    const box = labelBox(best, size);
    if (
      options.drop &&
      (placed.some((p) => boxesOverlap(box, p.box)) ||
        spots.some((o) => boxHitsCircle(box, o.unit, radius * 1.2 + 1)) ||
        (spot.inside && [[0, 0] as const, ...EDGES].some(([dx, dy]) => !spot.inside!([best[0] + dx * size, best[1] + dy * size]))))
    ) {
      continue;
    }
    out[spot.code] = best;
    placed.push({ code: spot.code, box });
  }
  return out;
}

export interface TapCandidate {
  code: string;
  at: Point;
}

/**
 * Which province a touch means. A finger is blunt and pieces are small, so a tap that
 * lands just outside a province the player can act on still counts for it: if the province
 * under the finger is not one of the `candidates`, the nearest candidate within `reach`
 * board units wins. Otherwise the province under the finger stands.
 */
export function resolveTap(point: Point, under: string | null, candidates: readonly TapCandidate[], reach: number): string | null {
  if (under && candidates.some((c) => c.code === under)) return under;
  let best: TapCandidate | null = null;
  let bestDist = reach;
  for (const c of candidates) {
    const d = Math.hypot(c.at[0] - point[0], c.at[1] - point[1]);
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best?.code ?? under;
}

/** Where a province code's size stops growing in board units, and a piece's (see the sizes above). */
export const LABEL_CAP = 16;
export const UNIT_CAP = 12.5;

/**
 * The piece radius and code size the board draws at a scale, rounded so a pan or a hair of zoom
 * does not lay every label out again: to a quarter unit, or a whole one past the caps (a far-out
 * overview on a small screen, where the sizes are held at a floor in pixels).
 */
export function boardSizes(scale: number): { r: number; size: number } {
  const step = (v: number, cap: number) => (v > cap ? Math.round(v) : Math.round(v * 4) / 4);
  return { r: step(unitRadius(scale), UNIT_CAP), size: step(labelSize(scale), LABEL_CAP) };
}

/** A label spot and how much its code matters when not every code fits: lower is kept first. */
export interface RankedSpot extends LabelSpot {
  worth: number;
}

/**
 * Every province code the board draws at this size. Up to the cap, all of them. Past it the
 * codes are at a readable floor and could not all fit, so they are placed most important first
 * (supply centres, then land, then sea) and a code with no clear spot inside its province is
 * left for the player to zoom in to.
 */
export function placeLabels(spots: readonly RankedSpot[], radius: number, size: number): Record<string, Point> {
  if (size <= LABEL_CAP) return layoutLabels(spots, radius, size);
  return layoutLabels([...spots].sort((a, b) => a.worth - b.worth), radius, size, { drop: true });
}

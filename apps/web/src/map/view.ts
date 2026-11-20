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
  /**
   * Never left out, however crowded the map: when no spot inside the province is clear, the
   * code is set beside it, clear of the other codes and the pieces, with a leader to `anchor`.
   * Supply centres are kept, so a far-out overview still names every centre.
   */
  keep?: boolean | undefined;
  /** What a leader points at (the supply centre); the piece position when not given. */
  anchor?: Point | undefined;
}

type LabelBox = { x0: number; y0: number; x1: number; y1: number };

/** Roughly how much room a three-letter code takes at a given size. */
function labelBox(at: Point, size: number): LabelBox {
  const halfW = size * 1.02;
  const halfH = size * 0.45;
  return { x0: at[0] - halfW, y0: at[1] - halfH, x1: at[0] + halfW, y1: at[1] + halfH };
}

function boxHitsCircle(box: LabelBox, c: Point, r: number): boolean {
  const nx = clampNumber(c[0], box.x0, box.x1);
  const ny = clampNumber(c[1], box.y0, box.y1);
  return Math.hypot(c[0] - nx, c[1] - ny) < r;
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
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

/** How far out a code set beside its province may go, in clearances, and at which angles. */
const CALLOUT_REACH = [0.7, 1, 1.35, 1.75, 2.2, 2.8, 3.5] as const;
const CALLOUT_TURNS = [90, 270, 0, 180, 45, 135, 315, 225, 22, 68, 112, 158, 202, 248, 292, 338] as const;

export interface LabelOptions {
  /**
   * Leave out a code that has no spot clear of the codes already placed and of the pieces
   * (unless its spot is `keep`). For a far-out overview, where every code at a readable size
   * would be a wall of text: the codes that fit are drawn (put the ones that matter first),
   * and zooming in brings the rest.
   */
  drop?: boolean | undefined;
}

/**
 * Place every province code for a piece radius and text size. Each code first tries the
 * side of the piece the map maker chose, then the other sides, and takes the first spot
 * that covers no piece position and no code already placed. Where the map is too crowded
 * for a clean answer (the English Midlands) it takes the least bad one.
 */
export function layoutLabels(spots: readonly LabelSpot[], radius: number, size: number, options: LabelOptions = {}): Record<string, Point> {
  const placed: LabelBox[] = [];
  const out: Record<string, Point> = {};
  // Every piece position, occupied or not, so a code keeps its place whoever stands where.
  const pieces = spots.map((s) => s.unit);
  // Fleets are drawn a little wider than the radius.
  const reach = radius * 1.2 + 1;
  const vertical = radius * 1.1 + size * 0.62 + 1.5;
  const sideways = radius + size * 1.02 + 2;
  const covers = (box: LabelBox) => {
    let n = 0;
    for (const p of pieces) if (boxHitsCircle(box, p, reach)) n++;
    return n;
  };
  const crowds = (box: LabelBox) => {
    let n = 0;
    for (const p of placed) if (boxesOverlap(box, p)) n++;
    return n;
  };
  const clean = (spot: LabelSpot, at: Point) => {
    const box = labelBox(at, size);
    return (
      crowds(box) === 0 &&
      covers(box) === 0 &&
      !(spot.inside && [[0, 0] as const, ...EDGES].some(([dx, dy]) => !spot.inside!([at[0] + dx * size, at[1] + dy * size])))
    );
  };
  const put = (code: string, at: Point) => {
    out[code] = at;
    placed.push(labelBox(at, size));
  };

  /** The best spot round the piece, inside the province if it can be. */
  const nearest = (spot: LabelSpot): Point => {
    const preferred = placeLabel(spot.unit, spot.label, radius, size);
    const [ux, uy] = spot.unit;
    // Below, above and beside first (how a map is usually lettered), then all round the piece,
    // then further out for a long thin province whose near spots fall outside it.
    const candidates: Point[] = [preferred];
    for (const [far, turns] of RINGS) {
      for (const turn of turns) {
        const a = (turn * Math.PI) / 180;
        candidates.push([ux + Math.cos(a) * sideways * far, uy + Math.sin(a) * vertical * far]);
      }
    }
    let best = preferred;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const [i, at] of candidates.entries()) {
      const box = labelBox(at, size);
      let cost = i * 0.004; // earlier candidates win ties
      // Cheapest checks first, and stop as soon as this spot cannot beat the best so far.
      cost += crowds(box);
      if (cost >= bestCost) continue;
      cost += covers(box) * 2;
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
    return best;
  };

  /**
   * A kept code with no clear spot in its province: the nearest spot round its anchor that is
   * clear of every code and piece, wherever it falls, or the least crowded one.
   */
  const beside = (spot: LabelSpot): Point => {
    const [ax, ay] = spot.anchor ?? spot.unit;
    let best: Point = [ax, ay + vertical];
    let bestCost = Number.POSITIVE_INFINITY;
    for (const [ring, far] of CALLOUT_REACH.entries()) {
      for (const [i, turn] of CALLOUT_TURNS.entries()) {
        const a = (turn * Math.PI) / 180;
        const at: Point = [ax + Math.cos(a) * sideways * far, ay + Math.sin(a) * vertical * far];
        const box = labelBox(at, size);
        // Each step out costs more than any order of turns, and a clash more than any step.
        let cost = ring + i * 0.01 + crowds(box) * 20 + covers(box) * 10;
        if (spot.inside && !spot.inside(at)) cost += 0.5;
        if (cost < bestCost) {
          best = at;
          bestCost = cost;
        }
      }
      if (bestCost < ring + 1) break; // a clear spot at this reach: no need to look further out
    }
    return best;
  };

  // Kept codes with no clear spot inside their provinces are set beside them once every kept
  // code has had its chance inside, and before anything less important is laid.
  let kept: LabelSpot[] = [];
  const flush = () => {
    for (const spot of kept) put(spot.code, beside(spot));
    kept = [];
  };
  for (const spot of spots) {
    if (!spot.keep) flush();
    const at = nearest(spot);
    if (!options.drop || clean(spot, at)) put(spot.code, at);
    else if (spot.keep) kept.push(spot);
  }
  flush();
  return out;
}

/**
 * Where to draw the leader from a code set outside its province to the place it names: from
 * the anchor to the nearest edge of the code, stopping short of both. Null when the code sits
 * close enough to need none.
 */
export function leaderFor(at: Point, anchor: Point, size: number): [Point, Point] | null {
  const box = labelBox(at, size);
  const pad = size * 0.25;
  const nx = clampNumber(anchor[0], box.x0 - pad, box.x1 + pad);
  const ny = clampNumber(anchor[1], box.y0 - pad, box.y1 + pad);
  const dx = nx - anchor[0];
  const dy = ny - anchor[1];
  const length = Math.hypot(dx, dy);
  if (length < size * 0.6) return null;
  const gap = Math.min(size * 0.3, length / 3);
  return [[anchor[0] + (dx / length) * gap, anchor[1] + (dy / length) * gap], [nx, ny]];
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
 * (supply centres, then land, then sea). A supply centre's code is always drawn: inside its
 * province when there is room, else beside it (see `leaderFor`). Any other code with no clear
 * spot inside its province is left for the player to zoom in to.
 */
export function placeLabels(spots: readonly RankedSpot[], radius: number, size: number): Record<string, Point> {
  if (size <= LABEL_CAP) return layoutLabels(spots, radius, size);
  return layoutLabels([...spots].sort((a, b) => a.worth - b.worth), radius, size, { drop: true });
}

import type { State } from "@cabal/engine";
import {
  type CSSProperties,
  type PointerEvent,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseUnit } from "../game/notation.js";
import { type UnitIds, unitKey } from "../game/unitIds.js";
import { type Choreography, type Frame, type ResolutionInput, choreograph, standAside } from "../motion/choreography.js";
import { useReducedMotion } from "../motion/useReducedMotion.js";
import { deck, useSound } from "../sound/deck.js";
import { type MarkTiming, resultsTiming } from "./motion.js";
import { type LaidMark, convoyRoutes, layoutMarks } from "./marks.js";
import {
  type Board as BoardData,
  LABEL_OUTLINE_TOLERANCE,
  type Point,
  insideOutline,
  outlineOf,
  pathRings,
  regionPoint,
} from "./boardData.js";
import { markSizes } from "./geometry.js";
import {
  type Box,
  type Size,
  type TapCandidate,
  clampView,
  homeView,
  isWholeView,
  labelSize,
  layoutLabels,
  resolveTap,
  unitRadius,
  wholeView,
  zoomView,
} from "./view.js";

export const POWER_COLOR: Record<string, string> = {
  AUSTRIA: "var(--p-austria)",
  ENGLAND: "var(--p-england)",
  FRANCE: "var(--p-france)",
  GERMANY: "var(--p-germany)",
  ITALY: "var(--p-italy)",
  RUSSIA: "var(--p-russia)",
  TURKEY: "var(--p-turkey)",
};

export interface DrawnOrder {
  power: string;
  text: string;
  /** After adjudication: whether the order succeeded. */
  ok?: boolean | undefined;
}

/**
 * A resolved phase to play on the board: the positions before and after, the results, and
 * the unit ids for both (so each piece is walked, not swapped). `key` names the phase; the
 * choreography plays once per change of it.
 */
export interface Resolution extends ResolutionInput {
  key: string;
}

/** Units and provinces to pick out on the board, for the "why did this fail" panel. */
export interface BoardHighlight {
  /** The province of the order being explained: ringed in brass. */
  focus?: string | undefined;
  /** Provinces of units that helped it (supports that counted, its convoy): a dashed brass ring. */
  allies?: readonly string[] | undefined;
  /** Provinces of units that stood against it: a vermilion ring with sights. */
  against?: readonly string[] | undefined;
  /** Units whose orders stay inked (`A MUN`); every other order is faded back. */
  units?: readonly string[] | undefined;
}

/** A piece drawn as a dashed outline: where a what-if would leave a unit. */
export interface Ghost {
  power: string;
  kind: "A" | "F";
  region: string;
}

export interface BoardProps {
  board: BoardData;
  /** The position to draw. While a `resolution` plays, the position it started from. */
  state: State;
  orders: DrawnOrder[];
  /** Province of the selected unit. */
  selected?: string | null | undefined;
  /** Provinces the selected unit may act on. */
  targets?: ReadonlySet<string> | undefined;
  /** Provinces holding a unit that can be ordered now. With `targets`, what a near-miss tap snaps to. */
  hot?: ReadonlySet<string> | undefined;
  standoffs?: readonly string[] | undefined;
  /**
   * Set while a phase's results are shown, to a value unique to that phase: the order marks are
   * then inked in, in the order the adjudication tells, once per change of value. Implied by
   * `resolution`.
   */
  results?: string | undefined;
  /**
   * A resolved phase to play: the pieces march, bounce, are knocked aside, retreat, disband and
   * are built, in the four beats of motion/choreography.ts, then rest where the phase left them.
   * Without it the pieces of `state` are drawn where they stand.
   */
  resolution?: Resolution | undefined;
  /** Playback speed for the resolution (a replay's 2x). Defaults to 1. */
  rate?: number | undefined;
  /** Called once a resolution has finished playing, or was skipped, with its key. */
  onSettled?: ((key: string) => void) | undefined;
  /** Whether this board plays its sounds (when the player has sound on). Defaults to true. */
  sound?: boolean | undefined;
  /** Pick out the units behind one order and fade the rest. */
  highlight?: BoardHighlight | null | undefined;
  /** The orders are a sketch (what-if), not the game: drawn as such and stamped "What if". */
  sketch?: boolean | undefined;
  /** Dashed pieces where a sketch would leave units. */
  ghosts?: readonly Ghost[] | undefined;
  /** Stable unit identities for `state`, so a piece keeps its DOM node from phase to phase. */
  ids?: UnitIds | undefined;
  /** Provinces to frame when the frame is too small for the whole board (the active power's). */
  focus?: readonly string[] | undefined;
  /** Change this to bring the view back to `focus` (the player picked another power). */
  focusKey?: string | number | undefined;
  onProvince?: ((province: string, client: { x: number; y: number }) => void) | undefined;
}

/** The map is drawn in this many passes after the first (see Board). */
const LAST_PASS = 4;

/** How close, in CSS pixels, a touch must land to a province it can act on to count for it. */
const TOUCH_REACH_PX = 26;
/** The same reach in board units is capped, so on a far-out overview a tap cannot jump provinces away. */
const TOUCH_REACH_MAX = 48;

const OrderMark = memo(function OrderMark({
  board,
  order,
  laid,
  r,
  timing,
  lit,
}: {
  board: BoardData;
  order: DrawnOrder;
  laid: LaidMark;
  r: number;
  /** Results being shown: when this mark is drawn and its failure stamped. */
  timing?: MarkTiming | undefined;
  /** With a highlight on: this mark is one of the orders being explained (true) or faded (false). */
  lit?: boolean | undefined;
}) {
  const maskId = `ink${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const style = {
    "--power": POWER_COLOR[order.power] ?? "var(--ink)",
    ...(timing ? { "--delay": `${timing.delay}ms`, "--stamp": `${timing.stamp}ms` } : {}),
  } as CSSProperties;
  const shape = laid.shape;
  const cls = `order${order.ok === false ? " failed" : ""}${order.ok === true ? " ok" : ""}${
    lit === true ? " lit" : lit === false ? " dim" : ""
  }`;
  /**
   * Results are inked in: a solid copy of the stroke, drawn along its length, masks the real one,
   * so dashed supports and dotted convoys keep their rhythm while they draw.
   */
  const ink = (d: string) =>
    timing ? (
      <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={board.width} height={board.height}>
        <path className="reveal" pathLength={1} d={d} />
      </mask>
    ) : null;
  const masked = timing ? `url(#${maskId})` : undefined;
  const failMark = (at: Point) =>
    order.ok === false ? (
      <g className="fail-mark" transform={`translate(${at[0]} ${at[1]})`}>
        <g className="stamp" style={{ "--x": `${Math.max(3.5, r * 0.46)}px` } as CSSProperties}>
          <line x1={-Math.max(3.5, r * 0.46)} y1={-Math.max(3.5, r * 0.46)} x2={Math.max(3.5, r * 0.46)} y2={Math.max(3.5, r * 0.46)} />
          <line x1={Math.max(3.5, r * 0.46)} y1={-Math.max(3.5, r * 0.46)} x2={-Math.max(3.5, r * 0.46)} y2={Math.max(3.5, r * 0.46)} />
        </g>
      </g>
    ) : null;

  switch (shape.kind) {
    case "arrow":
      return (
        <g className={`${cls} ${shape.cls}`} style={style} data-order={order.text}>
          {ink(shape.d)}
          <g mask={masked}>
            <path className="halo" d={shape.d} />
            <path className="stroke" d={shape.d} />
          </g>
          <polygon className="head" points={shape.head} />
          {failMark(shape.failAt)}
        </g>
      );
    case "helper": {
      const k = shape.knot;
      return (
        <g className={`${cls} ${shape.cls}`} style={style} data-order={order.text}>
          {ink(shape.d)}
          <g mask={masked}>
            <path className="halo" d={shape.d} />
            <path className="stroke" d={shape.d} />
          </g>
          {shape.cls === "support" ? (
            <circle className="knot" cx={k.at[0]} cy={k.at[1]} r={k.r} />
          ) : (
            <rect className="knot" x={k.at[0] - k.r} y={k.at[1] - k.r} width={k.r * 2} height={k.r * 2} />
          )}
          {failMark(shape.failAt)}
        </g>
      );
    }
    case "ring":
      return (
        <g className={`${cls} ${shape.cls}`} style={style} data-order={order.text}>
          <circle className="halo" cx={shape.at[0]} cy={shape.at[1]} r={shape.r} />
          <circle className="stroke" cx={shape.at[0]} cy={shape.at[1]} r={shape.r} />
          {failMark(shape.failAt)}
        </g>
      );
    case "build":
      return (
        <g className={`${cls} build`} style={{ ...style, transform: `translate(${shape.at[0]}px, ${shape.at[1]}px)` }} data-order={order.text}>
          <UnitShape kind={shape.unit} r={r} ghost />
        </g>
      );
    case "disband":
      return (
        <g className={`${cls} disband`} style={style} transform={`translate(${shape.at[0]} ${shape.at[1]})`} data-order={order.text}>
          <line x1={-shape.r} y1={-shape.r} x2={shape.r} y2={shape.r} />
          <line x1={shape.r} y1={-shape.r} x2={-shape.r} y2={shape.r} />
        </g>
      );
  }
});

/** A piece drawn about the origin; its group is moved into place, so it can be marched later. */
function UnitShape({ kind, r, ghost = false }: { kind: "A" | "F"; r: number; ghost?: boolean }) {
  if (kind === "A") {
    return (
      <g className={ghost ? "piece ghost" : "piece"}>
        {ghost ? null : <circle className="shadow" cx={r * 0.13} cy={r * 0.17} r={r} />}
        <circle className="body" cx={0} cy={0} r={r} />
      </g>
    );
  }
  const s = r * 1.25;
  const pts = (ox: number, oy: number) => `${ox},${-s + oy} ${s * 0.95 + ox},${s * 0.7 + oy} ${-s * 0.95 + ox},${s * 0.7 + oy}`;
  return (
    <g className={ghost ? "piece ghost" : "piece"}>
      {ghost ? null : <polygon className="shadow" points={pts(r * 0.13, r * 0.17)} />}
      <polygon className="body" points={pts(0, 0)} />
    </g>
  );
}

/** Web Animation keyframes for a piece's frames, as shares of the whole phase. */
export function keyframesOf(frames: readonly Frame[], total: number): Keyframe[] {
  const kf: Keyframe[] = frames.map((f) => ({
    offset: Math.min(1, Math.max(0, total > 0 ? f.t / total : 1)),
    transform: `translate(${Math.round(f.x * 10) / 10}px, ${Math.round(f.y * 10) / 10}px) scale(${f.scale ?? 1})`,
    opacity: f.opacity ?? 1,
  }));
  if (kf.length === 0) return kf;
  if ((kf[0]!.offset as number) > 0) kf.unshift({ ...kf[0]!, offset: 0 });
  if ((kf.at(-1)!.offset as number) < 1) kf.push({ ...kf.at(-1)!, offset: 1 });
  return kf;
}

function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor" />
      {on ? <path d="M13 7.2a4 4 0 0 1 0 5.6M15.4 5a7 7 0 0 1 0 10" strokeLinecap="round" /> : <path d="M13.5 7.5l4 5M17.5 7.5l-4 5" strokeLinecap="round" />}
    </svg>
  );
}

/** Sea, lakes, impassable land and coastline: never changes, so it never re-renders. */
const Geography = memo(function Geography({ board, layer }: { board: BoardData; layer: "under" | "coast" | "lines" }) {
  if (layer === "coast") return <path className="coastline" d={board.coast} />;
  if (layer === "lines") return <path className="sea-lines" d={board.seaLines} />;
  return (
    <>
      <defs>
        <pattern id="impassable" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" className="impassable-bg" />
          <line x1="0" y1="0" x2="0" y2="6" className="impassable-line" />
        </pattern>
      </defs>
      <rect className="sea-bg" x={0} y={0} width={board.width} height={board.height} />
      {Object.entries(board.provinces)
        .filter(([, p]) => p.kind === "sea")
        .map(([code, p]) => (
          <path key={code} data-province={code} className="prov sea" d={p.d}>
            <title>{p.name}</title>
          </path>
        ))}
      {board.lakes.map((d, i) => (
        <path key={`lake-${i}`} className="lake" d={d} />
      ))}
      {board.impassable.map((d, i) => (
        <path key={`imp-${i}`} className="impassable" d={d} />
      ))}
    </>
  );
});

/** Land provinces tinted by who holds them, and the supply centre markers. Changes once a phase. */
const Territory = memo(function Territory({
  board,
  control,
  centerOwner,
  layer,
}: {
  board: BoardData;
  control: Record<string, string>;
  centerOwner: Record<string, string>;
  /** The land is drawn as two halves so neither is too much to lay out in one go. */
  layer: "land-a" | "land-b" | "centres";
}) {
  const provinces = Object.entries(board.provinces);
  if (layer === "centres") {
    return (
      <>
        {provinces.map(([code, p]) =>
          p.sc ? (
            <g
              key={`sc-${code}`}
              className={`sc${centerOwner[code] ? " owned" : ""}`}
              style={centerOwner[code] ? ({ "--power": POWER_COLOR[centerOwner[code]!] } as CSSProperties) : undefined}
            >
              <circle className="ring" cx={p.sc[0]} cy={p.sc[1]} r={4.2} />
              <circle className="dot" cx={p.sc[0]} cy={p.sc[1]} r={2} />
            </g>
          ) : null,
        )}
      </>
    );
  }
  return (
    <>
      {provinces
        .filter(([, p]) => p.kind !== "sea")
        .filter((_, i) => (i % 2 === 0) === (layer === "land-a"))
        .map(([code, p]) => {
          const owner = control[code];
          const style = owner ? ({ "--power": POWER_COLOR[owner] } as CSSProperties) : undefined;
          const cls = `prov ${p.kind === "impassable" ? "impassable-prov" : "land"}${owner ? " controlled" : ""}${
            centerOwner[code] ? " center-owned" : ""
          }`;
          return (
            <path key={code} data-province={code} className={cls} style={style} d={p.d}>
              <title>{p.name}</title>
            </path>
          );
        })}
    </>
  );
});

/** Province codes, sized for the zoom and laid out clear of the pieces and of each other. */
const Labels = memo(function Labels({ board, size, r }: { board: BoardData; size: number; r: number }) {
  const spots = useMemo(
    () =>
      Object.entries(board.provinces)
        .filter(([, p]) => p.kind !== "impassable")
        .map(([code, p]) => {
          // A thinned outline is plenty for placing a label, and far cheaper to test against.
          const outline = outlineOf(pathRings(p.d, LABEL_OUTLINE_TOLERANCE));
          return { code, unit: p.unit, label: p.label, inside: (point: Point) => insideOutline(outline, point[0], point[1]) };
        }),
    [board],
  );
  // Zooming passes through the same sizes again and again; each is laid out once.
  const cache = useRef(new Map<string, Record<string, Point>>());
  const at = useMemo(() => {
    const key = `${r}/${size}`;
    let layout = cache.current.get(key);
    if (!layout) {
      layout = layoutLabels(spots, r, size);
      cache.current.set(key, layout);
    }
    return layout;
  }, [spots, r, size]);
  return (
    <g className="labels" style={{ "--label-size": `${size}px` } as CSSProperties}>
      {spots.map(({ code }) => {
        const p = board.provinces[code]!;
        const [x, y] = at[code]!;
        return (
          <text key={code} className={`label ${p.kind === "sea" ? "sea" : "land"}`} x={x} y={y}>
            {code}
          </text>
        );
      })}
      {Object.entries(board.provinces).flatMap(([code, p]) =>
        Object.entries(p.coasts ?? {}).map(([coast, pt]) => (
          <text key={`${code}-${coast}`} className="coast-label" x={pt[0]} y={pt[1] + r + size * 0.55}>
            {coast}
          </text>
        )),
      )}
    </g>
  );
});

/**
 * The units behind one order, picked out: the order's own unit ringed twice in brass, its
 * helpers in dashed brass, the units against it in vermilion with sights. Shapes, not only
 * colours, so the picture holds without colour vision.
 */
function Highlight({ board, highlight, r }: { board: BoardData; highlight: BoardHighlight; r: number }) {
  const ring = markSizes(r).ring + 3;
  const at = (code: string): Point | null => board.provinces[code]?.unit ?? null;
  const focus = highlight.focus ? at(highlight.focus) : null;
  return (
    <g className="highlight">
      {(highlight.allies ?? []).map((code) => {
        const p = at(code);
        return p ? <circle key={`ally-${code}`} className="hl ally" cx={p[0]} cy={p[1]} r={ring} /> : null;
      })}
      {(highlight.against ?? []).map((code) => {
        const p = at(code);
        if (!p) return null;
        const t = ring * 0.55;
        return (
          <g key={`against-${code}`} className="hl against" transform={`translate(${p[0]} ${p[1]})`}>
            <circle r={ring} />
            <path d={`M0 ${-ring - t}V${-ring + t}M0 ${ring - t}V${ring + t}M${-ring - t} 0H${-ring + t}M${ring - t} 0H${ring + t}`} />
          </g>
        );
      })}
      {focus ? (
        <g className="hl focus" transform={`translate(${focus[0]} ${focus[1]})`}>
          <circle r={ring} />
          <circle className="outer" r={ring + Math.max(3, r * 0.4)} />
        </g>
      ) : null}
    </g>
  );
}

interface Gesture {
  pointers: Map<number, { x: number; y: number }>;
  start: { x: number; y: number; view: Box; dist: number } | null;
  moved: boolean;
}

export function Board({
  board,
  state,
  orders,
  selected,
  targets,
  hot,
  standoffs,
  results: resultsKey,
  resolution,
  rate = 1,
  onSettled,
  sound = true,
  highlight,
  sketch = false,
  ghosts,
  ids,
  focus,
  focusKey,
  onProvince,
}: BoardProps) {
  const results = resultsKey ?? resolution?.key;
  const reduced = useReducedMotion();
  const [soundOn, setSound] = useSound();
  const full = useMemo<Size>(() => ({ w: board.width, h: board.height }), [board]);
  /**
   * The frame's size in CSS pixels, once measured. Nothing is drawn before that: the map's
   * sizes depend on it, and drawing twice would double the cost of the first paint.
   */
  const [measuredFrame, setFrame] = useState<Size | null>(null);
  const frame = measuredFrame ?? full;
  const [view, setView] = useState<Box>(() => wholeView(full, full));
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture>({ pointers: new Map(), start: null, moved: false });
  /** Small boards fold the pan arrows behind a button; this is whether they are out. */
  const [panOpen, setPanOpen] = useState(false);
  /** True until the player zooms or pans: the view then follows the frame and the focus. */
  const auto = useRef(true);
  const measured = useRef(false);

  const focusPoints = useMemo<Point[]>(
    () => (focus ?? []).flatMap((code) => (board.provinces[code] ? [board.provinces[code]!.unit] : [])),
    [board, focus],
  );
  const focusRef = useRef(focusPoints);
  focusRef.current = focusPoints;

  // Follow the frame's size. A new shape re-frames an untouched view and re-clamps a moved one.
  // The observer reports the size the browser has already laid out, so nothing is measured
  // by force, and the redraw that follows is a transition React can do in slices.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const apply = (width: number, height: number) => {
      if (width < 1 || height < 1) return;
      const next = { w: width, h: height };
      measured.current = true;
      startTransition(() => {
        setFrame((old) => (old && Math.abs(old.w - next.w) < 0.5 && Math.abs(old.h - next.h) < 0.5 ? old : next));
        setView((v) => (auto.current ? homeView(full, next, focusRef.current) : clampView(full, next, v)));
      });
    };
    if (typeof ResizeObserver === "undefined") {
      const rect = el.getBoundingClientRect();
      apply(rect.width, rect.height);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect;
      if (box) apply(box.width, box.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [full]);

  // The map is 380 KB of outlines. Handing it to the browser in one piece freezes a phone for
  // a moment, so it is drawn in passes, a frame apart: sea and half the land, the rest of
  // the land, the coastline, then sea lanes, centres and pieces, then the province codes.
  const [pass, setPass] = useState(0);
  useEffect(() => {
    if (!measuredFrame || pass >= LAST_PASS) return;
    const frameId = requestAnimationFrame(() => startTransition(() => setPass((p) => Math.min(LAST_PASS, p + 1))));
    return () => cancelAnimationFrame(frameId);
  }, [measuredFrame, pass]);

  // The player chose another power: bring its theatre into view (small frames only).
  const firstFocus = useRef(true);
  useEffect(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
      return;
    }
    if (!measured.current) return;
    auto.current = true;
    setView(homeView(full, frame, focusRef.current));
    // Only an explicit change of power moves the map, never a resize or a new order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const scale = frame.w / view.w;
  // Round so a pan or a hair of zoom does not re-render every label.
  const r = Math.round(unitRadius(scale) * 4) / 4;
  const size = Math.round(labelSize(scale) * 4) / 4;

  const control = useMemo(() => {
    const owner: Record<string, string> = {};
    for (const [power, units] of Object.entries(state.units)) {
      for (const u of units) {
        if (u.startsWith("*")) continue;
        const ref = parseUnit(u);
        if (ref) owner[ref.province] = power;
      }
    }
    for (const [power, centers] of Object.entries(state.centers)) {
      for (const c of centers) owner[c] = power;
    }
    return owner;
  }, [state]);

  const centerOwner = useMemo(() => {
    const owner: Record<string, string> = {};
    for (const [power, centers] of Object.entries(state.centers)) for (const c of centers) owner[c] = power;
    return owner;
  }, [state]);


  // Every order's shape, worked out from the set (a support aims at the move it backs).
  const point = useCallback((region: string) => regionPoint(board, region), [board]);
  const textsKey = orders.map((o) => o.text).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const texts = useMemo(() => orders.map((o) => o.text), [textsKey]);
  const laid = useMemo(() => layoutMarks(texts, point, r), [texts, point, r]);

  /**
   * The choreography of the phase being shown. Worked out at the piece size the phase began
   * at, so a zoom while it plays does not start it again.
   */
  const rAtStart = useRef(r);
  const plan = useMemo<Choreography | null>(() => {
    if (!resolution) return null;
    rAtStart.current = r;
    return choreograph(resolution, orders, { point, r, routes: convoyRoutes(texts, point) }, { reduced });
    // Only a new phase (or a change of motion preference) plans again, never a zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolution?.key, point, reduced]);
  const timing = useMemo(
    () => (plan ? { marks: plan.marks, standoffs: plan.standoffs } : results ? resultsTiming(orders) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, results, textsKey],
  );

  const pieces = useMemo(() => {
    const list: { power: string; kind: "A" | "F"; at: Point; dislodged: boolean; key: string; label: string; gone?: boolean; turnsAt?: number }[] = [];
    const name = (power: string, unit: string, dislodged: boolean) =>
      `${power.charAt(0)}${power.slice(1).toLowerCase()}: ${unit}${dislodged ? " (dislodged)" : ""}`;
    if (plan) {
      // The pieces rest where the phase leaves them; their frames carry them there.
      for (const u of plan.units) {
        list.push({
          power: u.power,
          kind: u.kind,
          at: regionPoint(board, u.region),
          dislodged: u.dislodged,
          key: u.id,
          label: name(u.power, u.unit, u.dislodged),
          gone: u.gone,
          ...(u.turnsAt !== undefined ? { turnsAt: u.turnsAt } : {}),
        });
      }
      return list.sort((a, b) => Number(a.dislodged) - Number(b.dislodged) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }
    for (const [power, units] of Object.entries(state.units)) {
      for (const u of units) {
        const ref = parseUnit(u);
        if (!ref) continue;
        const dislodged = u.startsWith("*");
        list.push({
          power,
          kind: ref.kind,
          at: regionPoint(board, ref.region),
          dislodged,
          // The id follows the unit from phase to phase; the text key is the fallback.
          key: ids?.[unitKey(power, u)] ?? `${power}-${u}`,
          label: name(power, ref.unit, dislodged),
        });
      }
    }
    // A stable order keeps React from reshuffling nodes when the engine lists units differently.
    // (Plain comparison: `localeCompare` spends tens of milliseconds waking the collator.)
    // Dislodged pieces go last, so they are drawn over the unit that pushed them out: in a
    // retreat phase they are the pieces that matter.
    return list.sort((a, b) => Number(a.dislodged) - Number(b.dislodged) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }, [board, state, ids, plan]);

  // Playing the choreography: the pieces' frames become Web Animations (transform and opacity
  // only, on a layer of their own, so nothing is laid out again while they run), the marks'
  // CSS animations are put on the same clock, and the cues are handed to the sound deck.
  const liveRef = useRef<SVGSVGElement>(null);
  const [animating, setAnimating] = useState(false);
  const playing = useRef<{ all: () => Animation[]; stop: () => void; settle: () => void } | null>(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const unitsDrawn = measuredFrame !== null && pass >= 3;
  useLayoutEffect(() => {
    const svg = liveRef.current;
    if (!plan || !resolution || !svg || !unitsDrawn) return;
    const key = resolution.key;
    const total = Math.max(1, plan.total);
    const speed = rateRef.current > 0 ? rateRef.current : 1;
    const mine: Animation[] = [];
    if (typeof svg.animate === "function") {
      for (const u of plan.units) {
        if (!u.frames.length) continue;
        const el = svg.querySelector<SVGGElement>(`g.unit[data-unit="${CSS.escape(u.id)}"]`);
        if (el) mine.push(el.animate(keyframesOf(u.frames, total), { duration: total, fill: "both", easing: "linear" }));
      }
      if (reduced) {
        const marks = svg.querySelector(".order-marks");
        if (marks) mine.push(marks.animate([{ opacity: 0 }, { opacity: 1 }], { duration: total * 0.6, fill: "backwards" }));
      }
    }
    const all = () => (typeof svg.getAnimations === "function" ? svg.getAnimations({ subtree: true }) : mine);
    for (const a of all()) a.playbackRate = speed;
    const silence = sound ? deck.schedule(plan.cues, { rate: speed }) : () => {};
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      setAnimating(false);
      settled.current?.(key);
    };
    const timer = window.setTimeout(settle, total / speed + 30);
    const stop = () => {
      window.clearTimeout(timer);
      silence();
    };
    playing.current = { all, stop, settle };
    setAnimating(plan.total > 0);
    return () => {
      stop();
      for (const a of mine) a.cancel();
      playing.current = null;
      setAnimating(false);
    };
    // The sound switch and the speed are read when a phase starts; the effect below follows the speed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, unitsDrawn]);
  useEffect(() => {
    const p = playing.current;
    if (p && rate > 0) for (const a of p.all()) a.playbackRate = rate;
  }, [rate]);
  /** Jump to the end of the phase being played: every piece where it lands, every stamp down. */
  const skip = useCallback(() => {
    const p = playing.current;
    if (!p) return;
    for (const a of p.all()) {
      try {
        a.finish();
      } catch {
        // an animation with nothing left to play
      }
    }
    p.stop();
    p.settle();
  }, []);

  const candidates = useMemo<TapCandidate[]>(() => {
    const codes = new Set<string>([...(targets ?? []), ...(hot ?? [])]);
    return [...codes].flatMap((code) => (board.provinces[code] ? [{ code, at: board.provinces[code]!.unit }] : []));
  }, [board, targets, hot]);

  const move = useCallback(
    (next: (v: Box) => Box) => {
      auto.current = false;
      setView((v) => clampView(full, frame, next(v)));
    },
    [full, frame],
  );

  const zoomBy = (factor: number, at?: Point) => move((v) => zoomView(full, frame, v, factor, at));
  /** Move the zoomed view by a share of its size: the button alternative to dragging. */
  const pan = (fx: number, fy: number) => move((v) => ({ ...v, x: v.x + v.w * fx, y: v.y + v.h * fy }));
  const showAll = () => {
    auto.current = false;
    setView(wholeView(full, frame));
  };

  const toBoard = (clientX: number, clientY: number, v: Box): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [v.x + ((clientX - rect.left) / rect.width) * v.w, v.y + ((clientY - rect.top) / rect.height) * v.h];
  };

  // React registers wheel listeners as passive, so preventDefault there is ignored and a
  // ctrl+wheel (or trackpad pinch) would zoom the whole page too. Listen natively instead.
  const wheel = useRef<(e: globalThis.WheelEvent) => void>(() => {});
  wheel.current = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY * 0.01), toBoard(e.clientX, e.clientY, view));
  };
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const listener = (e: globalThis.WheelEvent) => wheel.current(e);
    svg.addEventListener("wheel", listener, { passive: false });
    return () => svg.removeEventListener("wheel", listener);
  }, [measuredFrame !== null]);

  const whole = isWholeView(full, frame, view);

  const endGesture = () => {
    const g = gesture.current;
    g.pointers.clear();
    g.start = null;
    g.moved = false;
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const g = gesture.current;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...g.pointers.values()];
    const dist = pts.length === 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 0;
    g.start = { x: e.clientX, y: e.clientY, view, dist };
    g.moved = false;
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g.start || !g.pointers.has(e.pointerId)) return;
    // A mouse button released where the board could not see it (outside the window) must
    // not leave the map stuck to the cursor.
    if (e.pointerType === "mouse" && e.buttons === 0) return endGesture();
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...g.pointers.values()];
    const rect = svgRef.current!.getBoundingClientRect();
    const begin = g.start;
    if (pts.length === 2 && begin.dist > 0) {
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      const centre = toBoard((pts[0]!.x + pts[1]!.x) / 2, (pts[0]!.y + pts[1]!.y) / 2, begin.view);
      g.moved = true;
      move(() => zoomView(full, frame, begin.view, dist / begin.dist, centre));
      return;
    }
    const dx = e.clientX - begin.x;
    const dy = e.clientY - begin.y;
    if (!g.moved && Math.hypot(dx, dy) < 6) return;
    if (isWholeView(full, frame, begin.view)) return; // nothing to pan at full size
    if (!g.moved) {
      g.moved = true;
      // Keep receiving this drag after the pointer leaves the board, so the release is
      // always seen and the drag always ends.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is already gone
      }
    }
    move(() => ({
      ...begin.view,
      x: begin.view.x - (dx / rect.width) * begin.view.w,
      y: begin.view.y - (dy / rect.height) * begin.view.h,
    }));
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g.pointers.has(e.pointerId)) return;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size > 0) return;
    const wasClick = !g.moved && e.type === "pointerup";
    endGesture();
    if (!wasClick || !onProvince) return;
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-province]")?.getAttribute("data-province") ?? null;
    const code =
      e.pointerType === "mouse"
        ? under
        : resolveTap(toBoard(e.clientX, e.clientY, view), under, candidates, Math.min(TOUCH_REACH_PX / scale, TOUCH_REACH_MAX));
    if (code) onProvince(code, { x: e.clientX, y: e.clientY });
  };

  const unitLayer = (
<g className="units">
          {(pass >= 3 ? pieces : []).map((u) => {
            const at = u.dislodged ? standAside(u.at, r) : u.at;
            return (
              <g
                key={u.key}
                className={`unit${u.dislodged ? " dislodged" : ""}${u.gone ? " gone" : ""}`}
                data-unit={u.key}
                style={
                  {
                    "--power": POWER_COLOR[u.power],
                    // Dislodged pieces stand off to the side of the province they lost.
                    transform: `translate(${at[0]}px, ${at[1]}px)`,
                    ...(u.gone ? { opacity: 0 } : {}),
                    ...(u.turnsAt !== undefined ? { "--turn": `${u.turnsAt}ms` } : {}),
                  } as CSSProperties
                }
              >
                <title>{u.label}</title>
                <UnitShape kind={u.kind} r={r} />
              </g>
            );
          })}
          {ghosts?.map((g) => {
            const at = regionPoint(board, g.region);
            return (
              <g
                key={`ghost-${g.power}-${g.region}`}
                className="unit ghost-unit"
                style={{ "--power": POWER_COLOR[g.power], transform: `translate(${at[0]}px, ${at[1]}px)` } as CSSProperties}
              >
                <UnitShape kind={g.kind} r={r} ghost />
              </g>
            );
          })}
        </g>
  );
  const markLayer = (
<g className={`order-marks${results ? " results" : ""}`} key={results ?? "orders"}>
          {orders.map((o, i) => {
            const mark = laid[i];
            if (!mark) return null;
            const lit = highlight?.units ? highlight.units.includes(mark.unit) : undefined;
            return (
              <OrderMark
                key={`${o.power}-${o.text}-${i}`}
                board={board}
                order={o}
                laid={mark}
                r={r}
                timing={timing?.marks[i]}
                lit={lit}
              />
            );
          })}
        </g>
  );

  if (!measuredFrame) {
    return <div className="board-frame" ref={frameRef} style={{ "--board-aspect": full.w / full.h } as CSSProperties} />;
  }

  return (
    <div className="board-frame" ref={frameRef} style={{ "--board-aspect": full.w / full.h } as CSSProperties}>
      <svg
        ref={svgRef}
        className="board"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        role="img"
        aria-label="Diplomacy board. The same positions are listed under Board as text, and orders can be given with the choices under the map."
        data-whole={whole}
        style={{ touchAction: whole ? "pan-y" : "none", "--unit-r": r } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={endGesture}
      >
        <Geography board={board} layer="under" />
        <g className="land">
          <Territory board={board} control={control} centerOwner={centerOwner} layer="land-a" />
          {pass >= 1 ? <Territory board={board} control={control} centerOwner={centerOwner} layer="land-b" /> : null}
        </g>
        {pass >= 2 ? <Geography board={board} layer="coast" /> : null}
        {pass >= 3 ? <Geography board={board} layer="lines" /> : null}
        <rect className="sheet-edge" x={0} y={0} width={full.w} height={full.h} />

        {targets
          ? [...targets].map((code) => {
              const p = board.provinces[code];
              return p ? <path key={`t-${code}`} className="target" d={p.d} /> : null;
            })
          : null}
        {selected && board.provinces[selected] ? <path className="selected" d={board.provinces[selected]!.d} /> : null}

        {pass >= 3 ? <Territory board={board} control={control} centerOwner={centerOwner} layer="centres" /> : null}
        {pass >= LAST_PASS ? <Labels board={board} size={size} r={r} /> : <g className="labels" />}
      </svg>

      {/* Pieces and order marks, on a layer of their own: what moves never repaints the map. */}
      <svg
        ref={liveRef}
        className={`board-live${sketch ? " sketch" : ""}${highlight ? " highlighting" : ""}`}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        aria-hidden="true"
        focusable="false"
        style={{ "--unit-r": r } as CSSProperties}
      >
        {standoffs?.map((code) => {
          const p = board.provinces[code];
          return p ? (
            <path
              key={`so-${results ?? ""}-${code}`}
              className="standoff"
              d={p.d}
              style={timing ? ({ "--delay": `${timing.standoffs}ms` } as CSSProperties) : undefined}
            />
          ) : null;
        })}
        {highlight ? <Highlight board={board} highlight={highlight} r={r} /> : null}
        {/* Written orders are drawn over the pieces; a phase's results under them, so a piece that
            has marched stands on the head of its own arrow. The pieces keep their place in the
            tree either way, so each keeps its DOM node from phase to phase. */}
        {results ? markLayer : null}
        {unitLayer}
        {results ? null : markLayer}
      </svg>
      {sketch ? (
        <div className="sketch-stamp" aria-hidden="true">
          What if
        </div>
      ) : null}

      <div className="board-tools" role="group" aria-label="Board">
        <button
          type="button"
          className="sound-toggle"
          aria-pressed={soundOn}
          aria-label="Sound"
          title={soundOn ? "Sound is on" : "Sound is off"}
          onClick={() => setSound(!soundOn)}
        >
          <SoundIcon on={soundOn} />
        </button>
        {animating ? (
          <button type="button" className="skip" onClick={skip}>
            Skip<span className="sr-only"> the animation</span>
          </button>
        ) : null}
      </div>

      <div className="zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoomBy(1.5)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out" disabled={whole}>
          −
        </button>
        <button type="button" onClick={showAll} aria-label="Show the whole board" disabled={whole}>
          ⤢
        </button>
        {whole ? null : (
          <button
            type="button"
            className="pan-toggle"
            aria-expanded={panOpen}
            aria-controls="board-pan"
            aria-label="Move the map with buttons"
            onClick={() => setPanOpen((open) => !open)}
          >
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M10 2v16M2 10h16M10 2 7.5 4.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5" />
            </svg>
          </button>
        )}
      </div>
      {whole ? null : (
        <div className="pan" id="board-pan" role="group" aria-label="Move the map" data-open={panOpen}>
          <button type="button" onClick={() => pan(-0.25, 0)} aria-label="Pan left">
            ←
          </button>
          <button type="button" onClick={() => pan(0, -0.25)} aria-label="Pan up">
            ↑
          </button>
          <button type="button" onClick={() => pan(0, 0.25)} aria-label="Pan down">
            ↓
          </button>
          <button type="button" onClick={() => pan(0.25, 0)} aria-label="Pan right">
            →
          </button>
        </div>
      )}
    </div>
  );
}

import type { State } from "@cabal/engine";
import {
  type CSSProperties,
  type PointerEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ParsedOrder, parseOrder, parseUnit } from "../game/notation.js";
import { type UnitIds, unitKey } from "../game/unitIds.js";
import { type Board as BoardData, type Point, insideRings, pathRings, regionPoint } from "./boardData.js";
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

export interface BoardProps {
  board: BoardData;
  state: State;
  orders: DrawnOrder[];
  /** Province of the selected unit. */
  selected?: string | null | undefined;
  /** Provinces the selected unit may act on. */
  targets?: ReadonlySet<string> | undefined;
  /** Provinces holding a unit that can be ordered now. With `targets`, what a near-miss tap snaps to. */
  hot?: ReadonlySet<string> | undefined;
  standoffs?: readonly string[] | undefined;
  /** Stable unit identities for `state`, so a piece keeps its DOM node from phase to phase. */
  ids?: UnitIds | undefined;
  /** Provinces to frame when the frame is too small for the whole board (the active power's). */
  focus?: readonly string[] | undefined;
  /** Change this to bring the view back to `focus` (the player picked another power). */
  focusKey?: string | number | undefined;
  onProvince?: ((province: string, client: { x: number; y: number }) => void) | undefined;
}

/** How close, in CSS pixels, a touch must land to a province it can act on to count for it. */
const TOUCH_REACH_PX = 26;
/** The same reach in board units is capped, so on a far-out overview a tap cannot jump provinces away. */
const TOUCH_REACH_MAX = 34;

function toward(from: Point, to: Point, trimStart: number, trimEnd: number): [Point, Point] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return [
    [from[0] + ux * trimStart, from[1] + uy * trimStart],
    [to[0] - ux * trimEnd, to[1] - uy * trimEnd],
  ];
}

function arrowHead(from: Point, tip: Point, size = 8): string {
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip[0] - ux * size;
  const by = tip[1] - uy * size;
  const half = size * 0.55;
  return `${tip[0]},${tip[1]} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}`;
}

function mid(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

const OrderMark = memo(function OrderMark({ board, order, r }: { board: BoardData; order: DrawnOrder; r: number }) {
  const parsed: ParsedOrder | null = parseOrder(order.text);
  if (!parsed || parsed.type === "waive") return null;
  const style = { "--power": POWER_COLOR[order.power] ?? "var(--ink)" } as CSSProperties;
  const cls = `order${order.ok === false ? " failed" : ""}${order.ok === true ? " ok" : ""}`;
  const at = regionPoint(board, parsed.unit.region);

  const line = (a: Point, b: Point, kind: string, head = true) => {
    const cross = mid(a, b);
    return (
      <g className={`${cls} ${kind}`} style={style}>
        <line className="halo" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
        <line className="stroke" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
        {head ? <polygon className="head" points={arrowHead(a, b, Math.max(8, r * 0.8))} /> : null}
        {order.ok === false ? (
          <g className="fail-mark" transform={`translate(${cross[0]} ${cross[1]})`}>
            <line x1={-4} y1={-4} x2={4} y2={4} />
            <line x1={4} y1={-4} x2={-4} y2={4} />
          </g>
        ) : null}
      </g>
    );
  };

  switch (parsed.type) {
    case "hold":
      return (
        <g className={`${cls} hold`} style={style}>
          <circle cx={at[0]} cy={at[1]} r={r + 4.5} />
        </g>
      );
    case "move":
    case "retreat": {
      const [a, b] = toward(at, regionPoint(board, parsed.dest), r + 2, 3);
      return line(a, b, parsed.type === "retreat" ? "retreat" : parsed.via ? "move via" : "move");
    }
    case "support-hold": {
      const [a, b] = toward(at, regionPoint(board, parsed.target.region), r + 2, r + 5);
      return line(a, b, "support");
    }
    case "support-move": {
      const target = regionPoint(board, parsed.target.region);
      const dest = regionPoint(board, parsed.dest);
      const [a, b] = toward(at, mid(target, dest), r + 2, 2);
      return line(a, b, "support");
    }
    case "convoy": {
      const army = regionPoint(board, parsed.army.region);
      const dest = regionPoint(board, parsed.dest);
      const [a, b] = toward(at, mid(army, dest), r + 2, 2);
      return line(a, b, "convoy");
    }
    case "build":
      return (
        <g className={`${cls} build`} style={{ ...style, transform: `translate(${at[0]}px, ${at[1]}px)` }}>
          <UnitShape kind={parsed.unit.kind} r={r} ghost />
        </g>
      );
    case "disband":
      return (
        <g className={`${cls} disband`} style={style} transform={`translate(${at[0]} ${at[1]})`}>
          <line x1={-r} y1={-r} x2={r} y2={r} />
          <line x1={r} y1={-r} x2={-r} y2={r} />
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

/** Sea, lakes, impassable land and coastline: never changes, so it never re-renders. */
const Geography = memo(function Geography({ board, layer }: { board: BoardData; layer: "under" | "over" }) {
  if (layer === "over") {
    return (
      <>
        <path className="coastline" d={board.coast} />
        <path className="sea-lines" d={board.seaLines} />
      </>
    );
  }
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
  layer: "land" | "centres";
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
          const rings = pathRings(p.d);
          return { code, unit: p.unit, label: p.label, inside: (point: Point) => insideRings(rings, point) };
        }),
    [board],
  );
  const at = useMemo(() => layoutLabels(spots, r, size), [spots, r, size]);
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
  ids,
  focus,
  focusKey,
  onProvince,
}: BoardProps) {
  const full = useMemo<Size>(() => ({ w: board.width, h: board.height }), [board]);
  /** The frame's size in CSS pixels. Until it is measured, assume the board's own shape. */
  const [frame, setFrame] = useState<Size>(full);
  const [view, setView] = useState<Box>(() => wholeView(full, full));
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture>({ pointers: new Map(), start: null, moved: false });
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
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const next = { w: rect.width, h: rect.height };
      measured.current = true;
      setFrame((old) => (Math.abs(old.w - next.w) < 0.5 && Math.abs(old.h - next.h) < 0.5 ? old : next));
      setView((v) => (auto.current ? homeView(full, next, focusRef.current) : clampView(full, next, v)));
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [full]);

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

  const pieces = useMemo(() => {
    const list: { power: string; kind: "A" | "F"; at: Point; dislodged: boolean; key: string; label: string }[] = [];
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
          label: `${power.charAt(0)}${power.slice(1).toLowerCase()}: ${ref.unit}${dislodged ? " (dislodged)" : ""}`,
        });
      }
    }
    // A stable order keeps React from reshuffling nodes when the engine lists units differently.
    return list.sort((a, b) => a.key.localeCompare(b.key));
  }, [board, state, ids]);

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
  }, []);

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
        <Territory board={board} control={control} centerOwner={centerOwner} layer="land" />
        <Geography board={board} layer="over" />
        <rect className="sheet-edge" x={0} y={0} width={full.w} height={full.h} />

        {standoffs?.map((code) => {
          const p = board.provinces[code];
          return p ? <path key={`so-${code}`} className="standoff" d={p.d} /> : null;
        })}
        {targets
          ? [...targets].map((code) => {
              const p = board.provinces[code];
              return p ? <path key={`t-${code}`} className="target" d={p.d} /> : null;
            })
          : null}
        {selected && board.provinces[selected] ? <path className="selected" d={board.provinces[selected]!.d} /> : null}

        <Territory board={board} control={control} centerOwner={centerOwner} layer="centres" />
        <Labels board={board} size={size} r={r} />

        <g className="units">
          {pieces.map((u) => (
            <g
              key={u.key}
              className={`unit${u.dislodged ? " dislodged" : ""}`}
              data-unit={u.key}
              style={
                {
                  "--power": POWER_COLOR[u.power],
                  // Dislodged pieces stand off to the side of the province they lost.
                  transform: `translate(${u.at[0] + (u.dislodged ? r * 1.15 : 0)}px, ${u.at[1] - (u.dislodged ? r * 1.15 : 0)}px)`,
                } as CSSProperties
              }
            >
              <title>{u.label}</title>
              <UnitShape kind={u.kind} r={r} />
            </g>
          ))}
        </g>
        <g className="order-marks">
          {orders.map((o, i) => (
            <OrderMark key={`${o.power}-${o.text}-${i}`} board={board} order={o} r={r} />
          ))}
        </g>
      </svg>

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
      </div>
      {whole ? null : (
        <div className="pan" role="group" aria-label="Move the map">
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

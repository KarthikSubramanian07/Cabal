import type { State } from "@cabal/engine";
import { type CSSProperties, type PointerEvent, type WheelEvent, useMemo, useRef, useState } from "react";
import { type ParsedOrder, parseOrder, parseUnit } from "../game/notation.js";
import { type Board as BoardData, type Point, regionPoint } from "./boardData.js";

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
  standoffs?: readonly string[] | undefined;
  onProvince?: ((province: string, client: { x: number; y: number }) => void) | undefined;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const UNIT_R = 9.5;

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

function OrderMark({ board, order }: { board: BoardData; order: DrawnOrder }) {
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
        {head ? <polygon className="head" points={arrowHead(a, b)} /> : null}
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
          <circle cx={at[0]} cy={at[1]} r={UNIT_R + 4.5} />
        </g>
      );
    case "move":
    case "retreat": {
      const [a, b] = toward(at, regionPoint(board, parsed.dest), UNIT_R + 2, 3);
      return line(a, b, parsed.type === "retreat" ? "retreat" : "move");
    }
    case "support-hold": {
      const [a, b] = toward(at, regionPoint(board, parsed.target.region), UNIT_R + 2, UNIT_R + 5);
      return line(a, b, "support");
    }
    case "support-move": {
      const target = regionPoint(board, parsed.target.region);
      const dest = regionPoint(board, parsed.dest);
      const [a, b] = toward(at, mid(target, dest), UNIT_R + 2, 2);
      return line(a, b, "support");
    }
    case "convoy": {
      const army = regionPoint(board, parsed.army.region);
      const dest = regionPoint(board, parsed.dest);
      const [a, b] = toward(at, mid(army, dest), UNIT_R + 2, 2);
      return line(a, b, "convoy");
    }
    case "build":
      return (
        <g className={`${cls} build`} style={style}>
          <UnitShape kind={parsed.unit.kind} at={at} ghost />
        </g>
      );
    case "disband":
      return (
        <g className={`${cls} disband`} style={style} transform={`translate(${at[0]} ${at[1]})`}>
          <line x1={-9} y1={-9} x2={9} y2={9} />
          <line x1={9} y1={-9} x2={-9} y2={9} />
        </g>
      );
  }
}

function UnitShape({ kind, at, ghost = false }: { kind: "A" | "F"; at: Point; ghost?: boolean }) {
  const [x, y] = at;
  if (kind === "A") {
    return (
      <g className={ghost ? "piece ghost" : "piece"}>
        {ghost ? null : <circle className="shadow" cx={x + 1.2} cy={y + 1.6} r={UNIT_R} />}
        <circle className="body" cx={x} cy={y} r={UNIT_R} />
      </g>
    );
  }
  const s = UNIT_R * 1.25;
  const pts = (ox: number, oy: number) =>
    `${x + ox},${y - s + oy} ${x + s * 0.95 + ox},${y + s * 0.7 + oy} ${x - s * 0.95 + ox},${y + s * 0.7 + oy}`;
  return (
    <g className={ghost ? "piece ghost" : "piece"}>
      {ghost ? null : <polygon className="shadow" points={pts(1.2, 1.6)} />}
      <polygon className="body" points={pts(0, 0)} />
    </g>
  );
}

export function Board({ board, state, orders, selected, targets, standoffs, onProvince }: BoardProps) {
  const full: Box = { x: 0, y: 0, w: board.width, h: board.height };
  const [view, setView] = useState<Box>(full);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    start: { x: number; y: number; view: Box; dist: number } | null;
    moved: boolean;
  }>({ pointers: new Map(), start: null, moved: false });

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
    const list: { power: string; kind: "A" | "F"; at: Point; dislodged: boolean; key: string }[] = [];
    for (const [power, units] of Object.entries(state.units)) {
      for (const u of units) {
        const ref = parseUnit(u);
        if (!ref) continue;
        const dislodged = u.startsWith("*");
        const p = regionPoint(board, ref.region);
        list.push({
          power,
          kind: ref.kind,
          at: dislodged ? [p[0] + 11, p[1] - 11] : p,
          dislodged,
          key: `${power}-${u}`,
        });
      }
    }
    return list;
  }, [board, state]);

  const clamp = (b: Box): Box => {
    const w = Math.min(full.w, Math.max(full.w / 6, b.w));
    const h = (w * full.h) / full.w;
    return {
      w,
      h,
      x: Math.min(full.w - w, Math.max(0, b.x)),
      y: Math.min(full.h - h, Math.max(0, b.y)),
    };
  };

  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const px = cx ?? v.x + v.w / 2;
      const py = cy ?? v.y + v.h / 2;
      const w = v.w / factor;
      const h = v.h / factor;
      return clamp({ x: px - ((px - v.x) * w) / v.w, y: py - ((py - v.y) * h) / v.h, w, h });
    });
  };

  const toBoard = (clientX: number, clientY: number, v: Box) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: v.x + ((clientX - rect.left) / rect.width) * v.w, y: v.y + ((clientY - rect.top) / rect.height) * v.h };
  };

  const onWheel = (e: WheelEvent<SVGSVGElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const p = toBoard(e.clientX, e.clientY, view);
    zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
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
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...g.pointers.values()];
    const rect = svgRef.current!.getBoundingClientRect();
    if (pts.length === 2 && g.start.dist > 0) {
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      const factor = dist / g.start.dist;
      const c = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 };
      const p = toBoard(c.x, c.y, g.start.view);
      const w = g.start.view.w / factor;
      const h = g.start.view.h / factor;
      setView(
        clamp({
          x: p.x - ((p.x - g.start.view.x) * w) / g.start.view.w,
          y: p.y - ((p.y - g.start.view.y) * h) / g.start.view.h,
          w,
          h,
        }),
      );
      g.moved = true;
      return;
    }
    const dx = e.clientX - g.start.x;
    const dy = e.clientY - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) < 6) return;
    if (g.start.view.w >= full.w) return; // nothing to pan at full size
    g.moved = true;
    setView(
      clamp({
        ...g.start.view,
        x: g.start.view.x - (dx / rect.width) * g.start.view.w,
        y: g.start.view.y - (dy / rect.height) * g.start.view.h,
      }),
    );
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size > 0) return;
    const wasClick = !g.moved;
    g.start = null;
    if (!wasClick || !onProvince) return;
    const el = (e.target as Element).closest("[data-province]");
    const code = el?.getAttribute("data-province");
    if (code) onProvince(code, { x: e.clientX, y: e.clientY });
  };

  const provinces = Object.entries(board.provinces);
  const zoomed = view.w < full.w - 0.5;

  return (
    <div className="board-frame" style={{ "--board-aspect": full.w / full.h } as CSSProperties}>
      <svg
        ref={svgRef}
        className="board"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        role="img"
        aria-label="Diplomacy board"
        style={{ aspectRatio: `${full.w} / ${full.h}`, touchAction: zoomed ? "none" : "pan-y" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <pattern id="impassable" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" className="impassable-bg" />
            <line x1="0" y1="0" x2="0" y2="6" className="impassable-line" />
          </pattern>
        </defs>
        <rect className="sea-bg" x={0} y={0} width={full.w} height={full.h} />

        {provinces
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

        <path className="coastline" d={board.coast} />
        <path className="sea-lines" d={board.seaLines} />

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
        {provinces.map(([code, p]) =>
          p.kind === "impassable" ? null : (
            <text key={`l-${code}`} className={`label ${p.kind === "sea" ? "sea" : "land"}`} x={p.label[0]} y={p.label[1]}>
              {code}
            </text>
          ),
        )}
        {provinces.flatMap(([code, p]) =>
          Object.entries(p.coasts ?? {}).map(([coast, pt]) => (
            <text key={`c-${code}-${coast}`} className="coast-label" x={pt[0]} y={pt[1] + 3}>
              {coast}
            </text>
          )),
        )}

        {pieces.map((u) => (
          <g
            key={u.key}
            className={`unit${u.dislodged ? " dislodged" : ""}`}
            style={{ "--power": POWER_COLOR[u.power] } as CSSProperties}
          >
            <UnitShape kind={u.kind} at={u.at} />
          </g>
        ))}
        {orders.map((o, i) => (
          <OrderMark key={`${o.power}-${o.text}-${i}`} board={board} order={o} />
        ))}
      </svg>

      <div className="zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoomAt(1.5)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomAt(1 / 1.5)} aria-label="Zoom out" disabled={!zoomed}>
          −
        </button>
        <button type="button" onClick={() => setView(full)} aria-label="Show the whole board" disabled={!zoomed}>
          ⤢
        </button>
      </div>
    </div>
  );
}

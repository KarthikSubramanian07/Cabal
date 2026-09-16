import type { MapInfo, State } from "@cabal/engine";
import { type CSSProperties, useMemo } from "react";
import { drawable, unitOf } from "./orders.js";
import { CANVAS, NODE_RADIUS, POSITIONS, anchorOf } from "./positions.js";

export const POWER_VAR: Record<string, string> = {
  AUSTRIA: "var(--p-austria)",
  ENGLAND: "var(--p-england)",
  FRANCE: "var(--p-france)",
  GERMANY: "var(--p-germany)",
  ITALY: "var(--p-italy)",
  RUSSIA: "var(--p-russia)",
  TURKEY: "var(--p-turkey)",
};

const CODE_TO_NAME: Record<string, string> = {
  AUS: "AUSTRIA",
  ENG: "ENGLAND",
  FRA: "FRANCE",
  GER: "GERMANY",
  ITA: "ITALY",
  RUS: "RUSSIA",
  TUR: "TURKEY",
};

export interface MapProps {
  map: MapInfo;
  state: State;
  /** Orders to draw, with the power that gave them. */
  orders: { power: string; text: string; failed?: boolean }[];
  selectable: Set<string>;
  selected: string | null;
  onTap: (province: string, event: { x: number; y: number }) => void;
}

function hexagon(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

export function WarRoomMap({ map, state, orders, selectable, selected, onTap }: MapProps) {
  const owners = useMemo(() => {
    const o: Record<string, string> = {};
    for (const [power, centers] of Object.entries(state.centers)) {
      for (const c of centers) o[c] = power;
    }
    return o;
  }, [state.centers]);

  const units = useMemo(() => {
    const u: { power: string; kind: "A" | "F"; region: string }[] = [];
    for (const [power, list] of Object.entries(state.units)) {
      for (const text of list) {
        const parsed = unitOf(text.replace(/^\*/, ""));
        if (parsed) u.push({ power, kind: parsed.kind, region: parsed.region });
      }
    }
    return u;
  }, [state.units]);

  const edges = useMemo(() => {
    const seen = new Set<string>();
    const out: { a: string; b: string; sea: boolean }[] = [];
    for (const p of map.provinces) {
      for (const q of p.army_adjacent) {
        const key = [p.id, q].sort().join("|");
        if (!seen.has(key) && POSITIONS[p.id] && POSITIONS[q]) {
          seen.add(key);
          out.push({ a: p.id, b: q, sea: false });
        }
      }
      for (const list of Object.values(p.fleet_adjacent)) {
        for (const r of list) {
          const q = r.split("/")[0]!;
          const key = [p.id, q].sort().join("|");
          if (!seen.has(key) && POSITIONS[p.id] && POSITIONS[q]) {
            seen.add(key);
            out.push({ a: p.id, b: q, sea: p.terrain === "sea" || map.provinces.find((x) => x.id === q)?.terrain === "sea" });
          }
        }
      }
    }
    return out;
  }, [map]);

  return (
    <svg viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`} role="img" aria-label="Cabal war room map">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>
      <g>
        {edges.map((e) => {
          const a = POSITIONS[e.a]!;
          const b = POSITIONS[e.b]!;
          return <line key={`${e.a}-${e.b}`} className={`edge${e.sea ? " sea" : ""}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
      </g>
      <g>
        {map.provinces.map((p) => {
          const pos = POSITIONS[p.id];
          if (!pos) return null;
          const r = NODE_RADIUS[p.terrain as keyof typeof NODE_RADIUS] ?? 26;
          const owner = owners[p.id];
          const cls = ["province", p.terrain === "sea" ? "sea" : "", selectable.has(p.id) ? "selectable" : "", selected === p.id ? "selected" : ""]
            .filter(Boolean)
            .join(" ");
          const style = owner ? ({ "--power": POWER_VAR[owner] } as CSSProperties) : undefined;
          return (
            <g
              key={p.id}
              className={cls}
              style={style}
              onClick={(ev) => onTap(p.id, { x: ev.clientX, y: ev.clientY })}
            >
              <title>{p.name}</title>
              {p.terrain === "sea" ? (
                <circle className="fill" cx={pos.x} cy={pos.y} r={r} />
              ) : (
                <polygon className="fill" points={hexagon(pos.x, pos.y, r)} />
              )}
              {p.supply_center ? <circle className={`sc${owner ? " owned" : ""}`} cx={pos.x} cy={pos.y} r={r - 6} /> : null}
              <text className="label" x={pos.x} y={pos.y + r + 11}>
                {p.id}
              </text>
            </g>
          );
        })}
      </g>
      <g>
        {orders.map((o, i) => {
          const d = drawable(o.text);
          if (!d) return null;
          const style = { "--power": POWER_VAR[o.power] ?? "var(--fg)" } as CSSProperties;
          const failed = o.failed ? " failed" : "";
          switch (d.kind) {
            case "hold":
              return <circle key={i} className="order-hold" style={style} cx={d.at.x} cy={d.at.y} r={16} />;
            case "move":
            case "retreat":
              return (
                <line key={i} className={`order-arrow${failed}${d.kind === "retreat" ? " support" : ""}`} style={style} x1={d.from.x} y1={d.from.y} x2={d.to.x} y2={d.to.y} />
              );
            case "support":
              return <line key={i} className={`order-arrow support${failed}`} style={style} x1={d.from.x} y1={d.from.y} x2={d.to.x} y2={d.to.y} />;
            case "convoy":
              return <line key={i} className={`order-arrow convoy${failed}`} style={style} x1={d.from.x} y1={d.from.y} x2={d.to.x} y2={d.to.y} />;
            case "build":
              return <circle key={i} className="order-hold" style={style} cx={d.at.x} cy={d.at.y} r={20} strokeDasharray="3 3" />;
            case "disband":
              return (
                <g key={i} style={style}>
                  <line className="order-arrow" x1={d.at.x - 12} y1={d.at.y - 12} x2={d.at.x + 12} y2={d.at.y + 12} />
                  <line className="order-arrow" x1={d.at.x + 12} y1={d.at.y - 12} x2={d.at.x - 12} y2={d.at.y + 12} />
                </g>
              );
          }
        })}
      </g>
      <g>
        {units.map((u) => {
          const a = anchorOf(u.region);
          const style = { "--power": POWER_VAR[u.power] ?? "var(--fg)" } as CSSProperties;
          return (
            <g key={`${u.power}-${u.region}`} className="unit" style={style}>
              {u.kind === "A" ? (
                <circle className="body" cx={a.x} cy={a.y} r={10} />
              ) : (
                <rect className="body" x={a.x - 10} y={a.y - 8} width={20} height={16} rx={3} />
              )}
              <text className="glyph" x={a.x} y={a.y + 3.5}>
                {u.kind}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export { CODE_TO_NAME };

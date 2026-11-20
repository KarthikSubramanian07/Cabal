/**
 * The rating's path through a player's rated games, from the server's rating history: one ink
 * line on a ruled ground, a point per game, the latest point labelled, and behind it a brass band
 * for the range the rating is likely within (two deviations either side), which narrows as games
 * are played. The scale fits the line and today's range, so a newcomer's wide early range runs off
 * the frame rather than flattening the line. Each point is a stop for the keyboard and the
 * pointer, and says what the game did. The same figures are in a table beside it.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "../app/router.jsx";
import { powerLabel } from "../lobby/terms.js";
import { type RatingPoint, ratingRange, ratingTicks, signed } from "./record.js";

/** Drawn at the width it is shown at, so the type stays its own size on a phone. */
const WIDE = 640;
const H = 220;
const PAD = { top: 18, right: 64, bottom: 30, left: 48 };

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function range(p: RatingPoint): string {
  const [lo, hi] = ratingRange(p);
  return `${lo} to ${hi}`;
}

function pointLabel(p: RatingPoint): string {
  if (!p.game) return `Rating ${Math.round(p.rating)} before these games, likely ${range(p)}`;
  const as = p.game.power ? ` as ${powerLabel(p.game.power)}` : "";
  return `${signed(p.delta ?? 0)}${as} on ${day(p.game.finishedAt)}, to ${Math.round(p.rating)}, likely ${range(p)}`;
}

function gameLabel(game: NonNullable<RatingPoint["game"]>): string {
  return game.power ? `${powerLabel(game.power)}, ${day(game.finishedAt)}` : day(game.finishedAt);
}

/** `more`: older rated games exist than the points drawn. */
export function RatingChart({ points, more = false }: { points: RatingPoint[]; more?: boolean }) {
  const [hot, setHot] = useState<number | null>(null);
  const [W, setW] = useState(WIDE);
  const plot = useRef<HTMLDivElement>(null);
  const tableId = useId();
  useEffect(() => {
    const el = plot.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? WIDE);
      if (w > 0) setW(Math.max(280, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The scale holds the line and today's range around every point of it.
  const values = useMemo(() => {
    const spread = 2 * (points.at(-1)?.rd ?? 0);
    return points.flatMap((p) => [p.rating - spread, p.rating + spread]);
  }, [points]);
  const ticks = useMemo(() => ratingTicks(values), [values]);
  const clipId = useId();
  if (points.length < 2) return null;
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const x = (i: number) => PAD.left + (i * (W - PAD.left - PAD.right)) / (points.length - 1);
  const y = (v: number) => PAD.top + ((hi - v) * (H - PAD.top - PAD.bottom)) / (hi - lo || 1);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.rating).toFixed(1)}`).join("");
  const upper = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.rating + 2 * p.rd).toFixed(1)}`).join("");
  const lower = points.map((p, i) => `L${x(points.length - 1 - i).toFixed(1)} ${y(points[points.length - 1 - i]!.rating - 2 * points[points.length - 1 - i]!.rd).toFixed(1)}`).join("");
  const last = points.at(-1)!;
  const shown = hot !== null ? points[hot] : null;

  return (
    <figure className="rating-chart">
      <div className="rating-plot" ref={plot}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="group"
          aria-label={`Rating over ${more ? "the last " : ""}${points.length - 1} rated ${points.length === 2 ? "game" : "games"}, now ${Math.round(last.rating)}, likely ${range(last)}`}
          aria-describedby={tableId}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom} />
            </clipPath>
          </defs>
          <path className="rating-band" d={`${upper}${lower}Z`} clipPath={`url(#${clipId})`} />
          {ticks.map((t) => (
            <g key={t} className="rating-tick">
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <path className="rating-line" d={line} />
          {hot !== null ? <line className="rating-cross" x1={x(hot)} x2={x(hot)} y1={PAD.top} y2={H - PAD.bottom} /> : null}
          {points.map((p, i) => (
            <g
              key={i}
              className={`rating-point${hot === i ? " hot" : ""}${p.delta !== null && p.delta < 0 ? " down" : ""}`}
              tabIndex={0}
              role="img"
              aria-label={pointLabel(p)}
              onPointerEnter={() => setHot(i)}
              onPointerLeave={() => setHot((h) => (h === i ? null : h))}
              onFocus={() => setHot(i)}
              onBlur={() => setHot((h) => (h === i ? null : h))}
            >
              <circle className="rating-hit" cx={x(i)} cy={y(p.rating)} r={14} />
              <rect x={x(i) - 4.5} y={y(p.rating) - 4.5} width={9} height={9} />
            </g>
          ))}
          <text className="rating-end" x={x(points.length - 1) + 12} y={y(last.rating) + 5}>
            {Math.round(last.rating)}
          </text>
          <text className="rating-axis" x={PAD.left} y={H - 8}>
            {more ? "Older" : "First rated game"}
          </text>
          <text className="rating-axis" x={W - PAD.right} y={H - 8} textAnchor="end">
            Latest
          </text>
        </svg>
        {shown ? (
          <p className="rating-tip" style={{ left: `${(x(hot!) / W) * 100}%`, top: `${(y(shown.rating) / H) * 100}%` }} aria-hidden="true">
            {pointLabel(shown)}
          </p>
        ) : null}
      </div>
      <figcaption>
        <p className="rating-key">
          <span className="rating-key-band" aria-hidden="true" /> The band is where the rating is likely to be, two deviations either side. It narrows as more games are played.
        </p>
        <details>
          <summary>The figures</summary>
          <table className="ledger-table compact" id={tableId}>
            <caption className="sr-only">Rating after each rated game, oldest first, with the range it is likely within</caption>
            <thead>
              <tr>
                <th scope="col">Game</th>
                <th scope="col">Change</th>
                <th scope="col">Rating</th>
                <th scope="col">Likely range</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i}>
                  <th scope="row">
                    {p.game ? <Link href={`/replay/${p.game.gameId}`}>{gameLabel(p.game)}</Link> : more ? "Before these games" : "Before the first rated game"}
                  </th>
                  <td>{p.delta === null ? "" : signed(p.delta, 1)}</td>
                  <td>{Math.round(p.rating)}</td>
                  <td>{range(p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </figcaption>
    </figure>
  );
}

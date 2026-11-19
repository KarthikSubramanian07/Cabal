/**
 * The rating's path through a player's recent rated games: one ink line on a ruled ground, a
 * point per game, the latest point labelled. Each point is a stop for the keyboard and the
 * pointer, and says what the game did. The same figures are in a table beside it.
 */
import { useId, useMemo, useState } from "react";
import { Link } from "../app/router.jsx";
import { powerLabel } from "../lobby/terms.js";
import { type RatingPoint, ratingTicks, signed } from "./record.js";

const W = 640;
const H = 220;
const PAD = { top: 18, right: 64, bottom: 30, left: 48 };

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function pointLabel(p: RatingPoint): string {
  if (!p.game) return `Rating ${Math.round(p.rating)} before these games`;
  return `${signed(p.delta ?? 0)} as ${powerLabel(p.game.power)} on ${day(p.game.finishedAt)}, to ${Math.round(p.rating)}`;
}

export function RatingChart({ points }: { points: RatingPoint[] }) {
  const [hot, setHot] = useState<number | null>(null);
  const tableId = useId();
  const values = points.map((p) => p.rating);
  const ticks = useMemo(() => ratingTicks(values), [values]);
  if (points.length < 2) return null;
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const x = (i: number) => PAD.left + (i * (W - PAD.left - PAD.right)) / (points.length - 1);
  const y = (v: number) => PAD.top + ((hi - v) * (H - PAD.top - PAD.bottom)) / (hi - lo || 1);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.rating).toFixed(1)}`).join("");
  const last = points.at(-1)!;
  const shown = hot !== null ? points[hot] : null;

  return (
    <figure className="rating-chart">
      <div className="rating-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Rating over the last ${points.length - 1} rated games`} aria-describedby={tableId}>
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
            Older
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
        <details>
          <summary>The figures</summary>
          <table className="ledger-table compact" id={tableId}>
            <caption className="sr-only">Rating after each of the last rated games, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">Game</th>
                <th scope="col">Change</th>
                <th scope="col">Rating</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i}>
                  <th scope="row">
                    {p.game ? (
                      p.game.gameId ? (
                        <Link href={`/replay/${p.game.gameId}`}>
                          {powerLabel(p.game.power)}, {day(p.game.finishedAt)}
                        </Link>
                      ) : (
                        `${powerLabel(p.game.power)}, ${day(p.game.finishedAt)}`
                      )
                    ) : (
                      "Before these games"
                    )}
                  </th>
                  <td>{p.delta === null ? "" : signed(p.delta, 1)}</td>
                  <td>{Math.round(p.rating)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </figcaption>
    </figure>
  );
}

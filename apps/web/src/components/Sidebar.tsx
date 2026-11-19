import type { CSSProperties } from "react";
import type { PhaseRecord, PowerSummary } from "../game/useSandbox.js";
import { type PhaseKind, describePhase, parseOrder, titleCase } from "../game/notation.js";
import { receiptFor } from "../game/receipts.js";
import { POWER_COLOR } from "../map/Board.jsx";

export function PhaseHeader({ phase, status, viewing }: { phase: string; status: string; viewing: boolean }) {
  const { season, year, kind } = describePhase(phase);
  const ended = status !== "active";
  return (
    <div className="phase-header">
      <div className="phase-title">
        <span className="season">{season}</span> <span className="year">{year}</span>
      </div>
      <div className="phase-meta">
        {viewing ? <span className="tag">Results</span> : null}
        {kind ? <span>{kind}</span> : null}
        <code>{phase}</code>
      </div>
      {ended ? (
        <div className="game-over">
          {status.startsWith("solo:") ? `${titleCase(status.slice(5))} wins outright.` : "The game ended in a draw."}
        </div>
      ) : null}
    </div>
  );
}

export function PowerTable({
  powers,
  active,
  kind,
  onSelect,
}: {
  powers: PowerSummary[];
  active: string;
  kind: PhaseKind;
  onSelect: (power: string) => void;
}) {
  return (
    <table className="powers">
      <thead>
        <tr>
          <th scope="col">Power</th>
          <th scope="col" title="Supply centres">
            SC
          </th>
          <th scope="col">Units</th>
          <th scope="col">{kind === "A" ? "Adjust" : "Orders"}</th>
        </tr>
      </thead>
      <tbody>
        {powers.map((p) => {
          const done = p.due === 0 || p.given >= p.due;
          return (
            <tr
              key={p.power}
              className={p.power === active ? "active" : ""}
              style={{ "--power": POWER_COLOR[p.power] } as CSSProperties}
              onClick={() => onSelect(p.power)}
            >
              <th scope="row">
                <button type="button" aria-pressed={p.power === active}>
                  <span className="swatch" aria-hidden />
                  {titleCase(p.power)}
                </button>
              </th>
              <td>{p.centers}</td>
              <td>{p.units}</td>
              <td className={done ? "done" : ""}>
                {kind === "A" ? (
                  p.allowance === 0 ? (
                    "·"
                  ) : (
                    `${p.allowance > 0 ? "+" : ""}${p.allowance}`
                  )
                ) : p.due === 0 ? (
                  "·"
                ) : (
                  `${Math.min(p.given, p.due)}/${p.due}`
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function OrderList({
  power,
  kind,
  units,
  orders,
  allowance,
  onRemove,
  alternative,
  onReplace,
}: {
  power: string;
  kind: PhaseKind;
  /** Units that can be ordered this phase (movement and retreats). */
  units: string[];
  orders: Record<string, string>;
  allowance: number;
  onRemove: (key: string) => void;
  /** The same move by the other route (`... VIA`), when the unit could walk or be convoyed. */
  alternative?: (text: string) => string | null;
  onReplace?: (key: string, text: string) => void;
}) {
  if (kind === "A") {
    const entries = Object.entries(orders);
    return (
      <div className="orders" role="group" aria-label={`${titleCase(power)} orders`}>
        {allowance === 0 ? <p className="hint">{titleCase(power)} has nothing to build or disband.</p> : null}
        {allowance > 0 ? (
          <p className="hint">
            {titleCase(power)} may build {allowance} {allowance === 1 ? "unit" : "units"}. Click an empty home supply
            centre, or waive.
          </p>
        ) : null}
        {allowance < 0 ? (
          <p className="hint">
            {titleCase(power)} must disband {-allowance} {allowance === -1 ? "unit" : "units"}. Click a unit.
          </p>
        ) : null}
        {entries.map(([key, text]) => (
          <div className="row given" key={key}>
            <code>{text}</code>
            <button type="button" className="remove" aria-label={`Remove ${text}`} onClick={() => onRemove(key)}>
              ×
            </button>
          </div>
        ))}
      </div>
    );
  }
  if (units.length === 0) {
    return (
      <p className="hint">
        {kind === "R" ? `${titleCase(power)} has no units to retreat.` : `${titleCase(power)} has no units.`}
      </p>
    );
  }
  return (
    <div className="orders" role="group" aria-label={`${titleCase(power)} orders`}>
      {units.map((unit) => {
        const text = orders[unit];
        return (
          <div className={`row ${text ? "given" : "missing"}`} key={unit}>
            <code>{text ?? unit}</code>
            {text && alternative?.(text) ? (
              <button
                type="button"
                className="via"
                aria-pressed={text.endsWith(" VIA")}
                aria-label={`${text}: go by convoy`}
                onClick={() => onReplace?.(unit, alternative(text)!)}
              >
                By convoy
              </button>
            ) : null}
            {text ? (
              <button type="button" className="remove" aria-label={`Remove ${text}`} onClick={() => onRemove(unit)}>
                ×
              </button>
            ) : (
              <span className="default">{kind === "R" ? "disbands" : "holds"}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

type Names = Record<string, { name: string } | undefined>;

export function Results({ record, names }: { record: PhaseRecord; names?: Names }) {
  const place = (code: string) => names?.[code]?.name ?? code;
  const given = new Set(Object.values(record.orders).flatMap((o) => Object.values(o)));
  const byPower = new Map<string, typeof record.outcome.results>();
  for (const r of record.outcome.results) {
    const parsed = parseOrder(r.order);
    const implicitHold = parsed?.type === "hold" && r.ok && !given.has(r.order);
    if (implicitHold) continue;
    const list = byPower.get(r.power) ?? [];
    list.push(r);
    byPower.set(r.power, list);
  }
  const { dislodged, standoffs, civil_disorder: removed } = record.outcome;
  return (
    <div className="results" role="group" aria-label="Adjudication results">
      {[...byPower.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([power, list]) => (
        <section key={power} style={{ "--power": POWER_COLOR[power] } as CSSProperties}>
          <h3>
            <span className="swatch" aria-hidden />
            {titleCase(power)}
          </h3>
          {list.map((r, i) => {
            const receipt = receiptFor(r, record.phase, names);
            return (
              <div className={`receipt ${receipt.tone}`} key={`${r.order}-${i}`} data-code={r.code}>
                <span className="mark" aria-hidden="true">
                  {receipt.tone === "ok" ? "✓" : receipt.tone === "fail" ? "✕" : "–"}
                </span>
                <code>
                  {r.order}
                  <span className="sr-only">
                    {receipt.tone === "ok" ? ": succeeded" : receipt.tone === "fail" ? ": failed" : ": done"}
                  </span>
                </code>
                {receipt.detail ? <span className="why">{receipt.detail}</span> : null}
              </div>
            );
          })}
        </section>
      ))}
      {byPower.size === 0 ? <p className="hint">Every unit held.</p> : null}
      {dislodged.length || standoffs.length || removed.length ? (
        <section className="aftermath">
          {dislodged.map((d) => (
            <p key={d.unit}>
              <code>{d.unit}</code> was dislodged by the attack from {place(d.attacker_from)}.{" "}
              {d.retreat_options.length
                ? `It may retreat to ${d.retreat_options.map((o) => place(o.slice(0, 3)) + (o.length > 3 ? ` (${o.slice(4)})` : "")).join(", ")}.`
                : "It has nowhere to go and will be disbanded."}
            </p>
          ))}
          {standoffs.length ? <p>Standoff in {standoffs.map(place).join(", ")}. Nobody may retreat there.</p> : null}
          {removed.length ? <p>Removed in civil disorder: {removed.join(", ")}.</p> : null}
        </section>
      ) : null}
    </div>
  );
}

export function PhaseStepper({
  history,
  viewing,
  livePhase,
  onView,
}: {
  history: PhaseRecord[];
  viewing: number | null;
  livePhase: string;
  onView: (index: number | null) => void;
}) {
  if (history.length === 0) return null;
  const index = viewing ?? history.length;
  const go = (i: number) => onView(i >= history.length ? null : Math.max(0, i));
  return (
    <nav className="stepper" aria-label="Phase history">
      <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous phase">
        ‹
      </button>
      <select
        value={index}
        onChange={(e) => go(Number(e.target.value))}
        aria-label="Jump to phase"
      >
        {history.map((h, i) => (
          <option key={h.phase + i} value={i}>
            {h.phase} results
          </option>
        ))}
        <option value={history.length}>{livePhase} (now)</option>
      </select>
      <button type="button" onClick={() => go(index + 1)} disabled={viewing === null} aria-label="Next phase">
        ›
      </button>
    </nav>
  );
}

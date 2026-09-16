import type { CSSProperties } from "react";
import type { PhaseRecord, PowerSummary } from "../game/useSandbox.js";
import { type PhaseKind, describePhase, parseOrder, titleCase } from "../game/notation.js";
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
}: {
  power: string;
  kind: PhaseKind;
  /** Units that can be ordered this phase (movement and retreats). */
  units: string[];
  orders: Record<string, string>;
  allowance: number;
  onRemove: (key: string) => void;
}) {
  if (kind === "A") {
    const entries = Object.entries(orders);
    return (
      <div className="orders" aria-label={`${titleCase(power)} orders`}>
        {allowance === 0 ? <p className="hint">{titleCase(power)} has nothing to build or disband.</p> : null}
        {allowance > 0 ? (
          <p className="hint">
            {titleCase(power)} may build {allowance} {allowance === 1 ? "unit" : "units"}. Click an empty home supply
            centre.
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
            <button type="button" aria-label={`Remove ${text}`} onClick={() => onRemove(key)}>
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
    <div className="orders" aria-label={`${titleCase(power)} orders`}>
      {units.map((unit) => {
        const text = orders[unit];
        return (
          <div className={`row ${text ? "given" : "missing"}`} key={unit}>
            <code>{text ?? unit}</code>
            {text ? (
              <button type="button" aria-label={`Remove ${text}`} onClick={() => onRemove(unit)}>
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

export function Results({ record }: { record: PhaseRecord }) {
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
    <div className="results" aria-label="Adjudication results">
      {[...byPower.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([power, list]) => (
        <section key={power} style={{ "--power": POWER_COLOR[power] } as CSSProperties}>
          <h3>
            <span className="swatch" aria-hidden />
            {titleCase(power)}
          </h3>
          {list.map((r, i) => (
            <div className={`receipt ${r.ok ? "ok" : "fail"}`} key={`${r.order}-${i}`}>
              <span className="mark" aria-label={r.ok ? "succeeded" : "failed"}>
                {r.ok ? "✓" : "✕"}
              </span>
              <code>{r.order}</code>
              {r.ok ? null : <span className="why">{r.reason}</span>}
            </div>
          ))}
        </section>
      ))}
      {byPower.size === 0 ? <p className="hint">Every unit held.</p> : null}
      {dislodged.length || standoffs.length || removed.length ? (
        <section className="aftermath">
          {dislodged.map((d) => (
            <p key={d.unit}>
              <code>{d.unit}</code> was dislodged by the attack from {d.attacker_from}.{" "}
              {d.retreat_options.length ? `It may retreat to ${d.retreat_options.join(", ")}.` : "It has nowhere to go."}
            </p>
          ))}
          {standoffs.length ? <p>Standoff in {standoffs.join(", ")}. Nobody may retreat there.</p> : null}
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

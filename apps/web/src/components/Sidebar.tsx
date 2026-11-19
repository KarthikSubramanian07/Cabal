import { type CSSProperties, useMemo } from "react";
import { ReplayScrubber } from "../motion/ReplayScrubber.jsx";
import { timeline } from "../motion/timeline.js";
import type { PhaseRecord, PowerSummary } from "../game/useSandbox.js";
import { type PhaseKind, describePhase, parseOrder, titleCase } from "../game/notation.js";
import { receiptFor } from "../game/receipts.js";
import { SPEEDS, type Speed, speedLabel } from "../game/replay.js";
import { phaseLine } from "../game/describe.js";
import { POWER_COLOR } from "../map/Board.jsx";
import type { OrderResult } from "../engine.js";
import { type Why, hasWhy } from "../game/explain/explain.js";
import { WhyPanel } from "../game/explain/WhyPanel.jsx";

export function PhaseHeader({ phase, status, viewing }: { phase: string; status: string; viewing: boolean }) {
  const { season, year, kind } = describePhase(phase);
  const ended = status !== "active";
  return (
    <div className="phase-header">
      <h2 className="phase-title">
        <span className="season">{season}</span> <span className="year">{year}</span>
        {kind ? <span className="sr-only"> {kind}</span> : null}
      </h2>
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

/**
 * The key a receipt's "why" is opened by: its place in the phase's results, with its power and
 * order. Not the unit alone, which is empty for every build and so is shared by two of them.
 */
export const whyKey = (r: { power: string; order: string }, index: number) => `${index}|${r.power}|${r.order}`;

export function Results({
  record,
  names,
  explain,
  open,
  onOpen,
  label = "Adjudication results",
}: {
  record: Pick<PhaseRecord, "phase" | "orders" | "outcome">;
  names?: Names;
  /** The panel for a result, for every failed order that should offer one. */
  explain?: ((result: OrderResult) => Why | null) | undefined;
  /** The receipt whose panel is open (`whyKey`), if any. */
  open?: string | null | undefined;
  onOpen?: ((key: string | null) => void) | undefined;
  /** Names the group for assistive technology ("Predicted results" in a what-if). */
  label?: string;
}) {
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
    <div className="results" role="group" aria-label={label}>
      {[...byPower.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([power, list]) => (
        <section key={power} style={{ "--power": POWER_COLOR[power] } as CSSProperties}>
          <h3>
            <span className="swatch" aria-hidden />
            {titleCase(power)}
          </h3>
          {list.map((r, i) => {
            const receipt = receiptFor(r, record.phase, names, record.outcome.results);
            // A disband or a waived build is neutral on the receipt: nothing failed to explain.
            const why = explain && hasWhy(r) ? explain(r) : null;
            const key = whyKey(r, record.outcome.results.indexOf(r));
            const isOpen = why !== null && open === key;
            const panelId = `why-${key.replace(/[^A-Za-z0-9]/g, "-")}`;
            return (
              <div className={`receipt ${receipt.tone}${isOpen ? " open" : ""}`} key={`${r.order}-${i}`} data-code={r.code}>
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
                {why ? (
                  <button
                    type="button"
                    className="why-toggle"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => onOpen?.(isOpen ? null : key)}
                  >
                    Why?
                    <span className="sr-only"> {r.order}</span>
                  </button>
                ) : null}
                {isOpen && why ? <WhyPanel why={why} id={panelId} /> : null}
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
  playing,
  speed,
  onPlay,
  onPause,
  onSpeed,
  endLabel,
}: {
  history: PhaseRecord[];
  viewing: number | null;
  livePhase: string;
  /** How the position after the last phase is named; defaults to the live phase, `now`. A finished game's replay calls it the final position. */
  endLabel?: string | undefined;
  /** A step, a jump or a scrub by the player. Playback pauses for it. */
  onView: (index: number | null) => void;
  playing: boolean;
  speed: Speed;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (speed: Speed) => void;
}) {
  const marks = useMemo(() => timeline(history), [history]);
  if (history.length === 0) return null;
  const index = viewing ?? history.length;
  const go = (i: number) => onView(i >= history.length ? null : Math.max(0, i));
  const name = (i: number) => (i >= history.length ? (endLabel ?? `${phaseLine(livePhase)}, now`) : `${phaseLine(history[i]!.phase)} results`);
  return (
    <nav className="stepper" aria-label="Phase history">
      <div className="stepper-row">
        <button
          type="button"
          className="replay"
          onClick={playing ? onPause : onPlay}
          aria-label={playing ? "Pause the replay" : viewing === null ? "Replay the game from the start" : "Replay from here"}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            {playing ? (
              <>
                <rect x="3" y="2.5" width="3.4" height="11" />
                <rect x="9.6" y="2.5" width="3.4" height="11" />
              </>
            ) : (
              <path d="M4 2.2v11.6L13.6 8z" />
            )}
          </svg>
          <span className="replay-label">{playing ? "Pause" : "Replay"}</span>
        </button>
        <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous phase">
          ‹
        </button>
        <select value={index} onChange={(e) => go(Number(e.target.value))} aria-label="Jump to phase">
          {history.map((h, i) => (
            <option key={h.phase + i} value={i}>
              {name(i)}
            </option>
          ))}
          <option value={history.length}>{name(history.length)}</option>
        </select>
        <button type="button" onClick={() => go(index + 1)} disabled={viewing === null} aria-label="Next phase">
          ›
        </button>
      </div>
      <div className="stepper-row scrub">
        <ReplayScrubber
          marks={marks}
          index={index}
          onSeek={go}
          liveLabel={name(history.length)}
          phaseLabel={(m) => `${phaseLine(m.phase)} results`}
        />
        <div className="speeds" role="group" aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === speed}
              aria-label={`${speedLabel(s).short} ${speedLabel(s).long.toLowerCase()}`}
              onClick={() => onSpeed(s)}
            >
              {speedLabel(s).short}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}

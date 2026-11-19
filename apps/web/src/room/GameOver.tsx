/**
 * The end of a game: who won or shared it, the score each power takes away, and the Ledger, every
 * seal the viewer may read with its receipt, each opened again on this device.
 */
import type { GameSummary, LedgerResponse, PowerName, SeatView } from "@cabal/protocol";
import { type CSSProperties, useEffect, useId, useMemo, useState } from "react";
import { phaseLabel, powerLabel } from "../lobby/terms.js";
import { api, failureText } from "../net/api.js";
import { checkSeal, shortCommitment } from "./seals.js";

function headline(finished: NonNullable<GameSummary["finished"]>): string {
  const names = finished.winners.map(powerLabel);
  const list = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  if (finished.result === "solo") return `${list} takes Europe.`;
  if (finished.result === "draw") return `A draw, shared by ${list}.`;
  return "The game was abandoned.";
}

function reasonLine(reason: string | null): string | null {
  switch (reason) {
    case "vote":
      return "Every player at the table voted for it.";
    case "solo":
      return "Eighteen supply centres: an outright win.";
    case "engine_draw":
      return "The game reached its last year.";
    case "no_humans_left":
      return "No player was left on the board.";
    case "no_orders":
      return "Nobody sent orders for too long.";
    default:
      return null;
  }
}

export function GameOver({
  gameId,
  finished,
  seats,
  centres,
  token,
  engineReady,
}: {
  gameId: string;
  finished: NonNullable<GameSummary["finished"]>;
  seats: SeatView[];
  centres: Record<string, number>;
  token: string | undefined;
  engineReady: boolean;
}) {
  const titleId = useId();
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.ledger(gameId, token).then(
      (l) => live && setLedger(l),
      (e: unknown) => live && setError(failureText(e)),
    );
    return () => {
      live = false;
    };
  }, [gameId, token]);

  const rows = useMemo(
    () =>
      seats
        .map((s) => ({ seat: s, score: finished.scores[s.power] ?? 0, centres: centres[s.power] ?? 0 }))
        .sort((a, b) => b.score - a.score || b.centres - a.centres),
    [seats, finished.scores, centres],
  );
  const winners = new Set<PowerName>(finished.winners);
  const why = reasonLine(finished.reason);

  return (
    <section className="game-over-panel" aria-labelledby={titleId}>
      <p className={`stamp${finished.result === "abandoned" ? " alert" : ""}`} aria-hidden="true">
        {finished.result === "solo" ? "Victory" : finished.result === "draw" ? "Drawn" : "Abandoned"}
      </p>
      <h2 id={titleId} className="over-title">
        {headline(finished)}
      </h2>
      {why ? <p className="fine">{why}</p> : null}
      {finished.result !== "abandoned" ? (
        <table className="scores">
          <caption className="sr-only">Final scores</caption>
          <thead>
            <tr>
              <th scope="col">Power</th>
              <th scope="col">Centres</th>
              <th scope="col">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ seat, score, centres: c }) => (
              <tr key={seat.power} className={winners.has(seat.power) ? "won" : ""} style={{ "--power": `var(--p-${seat.power.toLowerCase()})` } as CSSProperties}>
                <th scope="row">
                  <span className="swatch" aria-hidden="true" />
                  {powerLabel(seat.power)}
                  <span className="score-who">{seat.kind === "ai" ? (seat.brain === "claude" ? "Claude" : "the bot") : (seat.name ?? "")}</span>
                </th>
                <td>{c}</td>
                <td>{(score * 100).toFixed(score > 0 && score < 0.1 ? 1 : 0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <h3 className="ledger-title">The Ledger</h3>
      {error ? <p className="form-error">{error}</p> : null}
      {!ledger && !error ? <p className="fine" role="status">Opening the ledger.</p> : null}
      {ledger ? (
        <>
          <ul className="ledger-totals" aria-label="Seals kept and broken, by power">
            {Object.entries(ledger.ledger)
              .filter(([, t]) => t.kept + t.broken + t.void > 0)
              .map(([power, t]) => (
                <li key={power} style={{ "--power": `var(--p-${power.toLowerCase()})` } as CSSProperties}>
                  <span className="ledger-power">{powerLabel(power)}</span>
                  <span className="kept">{t.kept} kept</span>
                  <span className="broken">{t.broken} broken</span>
                  {t.void ? <span className="void">{t.void} void</span> : null}
                </li>
              ))}
          </ul>
          {ledger.entries.length === 0 ? <p className="fine">No seals were made in this game.</p> : null}
          <ol className="ledger-entries">
            {ledger.entries.map((e) => {
              const opens = engineReady ? checkSeal(e) : "closed";
              return (
                <li key={e.id} className={`ledger-entry ${e.receipt}`}>
                  <p>
                    <strong>{powerLabel(e.pledger)}</strong> to {e.audience === "ALL" ? "the table" : powerLabel(e.audience)}, {phaseLabel(e.phase)}
                    <span className={`rubber small ${e.receipt}`}>{e.receipt}</span>
                  </p>
                  <p className="ledger-orders">
                    {e.orders.map((o) => (
                      <code key={o}>{o}</code>
                    ))}
                  </p>
                  <p className="fine">
                    {e.sealed ? "Sealed" : "Open"} <code title={e.commitment}>{shortCommitment(e.commitment)}</code>{" "}
                    {opens === "opens" ? "opens on this device." : opens === "fails" ? <strong className="bad">does not open with these orders.</strong> : null}
                  </p>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </section>
  );
}

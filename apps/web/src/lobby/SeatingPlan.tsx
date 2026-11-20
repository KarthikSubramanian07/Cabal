/**
 * The seating plan: seven place cards, one per power, in the board's own colours. In the lobby an
 * open card is the seat picker; once the game runs the cards say who is here and who has moved.
 */
import { Link } from "../app/router.jsx";
import type { PowerName, SeatView } from "@cabal/protocol";
import type { CSSProperties } from "react";
import { occupant, powerLabel } from "./terms.js";
import { trustFigure, trustNote, useTrust } from "./trust.js";

function state(seat: SeatView, running: boolean): string | null {
  if (seat.kind === "open") return null;
  if (seat.eliminated) return "Out of the game";
  if (!running) return seat.kind === "human" ? (seat.present ? "At the table" : "Away") : null;
  if (!seat.canAct) return "Nothing to order";
  return seat.submitted ? (seat.ready ? "Orders in, ready" : "Orders in") : "Thinking";
}

export function SeatingPlan({
  seats,
  me,
  running,
  picking,
  selected,
  onSelect,
}: {
  seats: SeatView[];
  me: PowerName | null;
  /** The game has started: show orders status instead of presence. */
  running: boolean;
  /** Open seats can be chosen (the viewer holds no seat and the table is open). */
  picking: boolean;
  selected: PowerName | null;
  onSelect: (power: PowerName | null) => void;
}) {
  const trust = useTrust(seats.map((s) => s.handle));
  return (
    <ul className="seating" aria-label="Seats">
      {seats.map((seat) => {
        const style = { "--power": `var(--p-${seat.power.toLowerCase()})` } as CSSProperties;
        const status = state(seat, running);
        const word = seat.handle && seat.kind !== "open" ? trust[seat.handle.toLowerCase()] : undefined;
        const marks = (
          <>
            {seat.host ? <span className="mark">Host</span> : null}
            {seat.power === me ? <span className="mark you">You</span> : null}
          </>
        );
        const body = (
          <>
            {/* The marks sit beside the power's name and wrap under it, never over it. */}
            <span className="place-head">
              <span className="place-power">{powerLabel(seat.power)}</span>
              {seat.host || seat.power === me ? <span className="place-marks">{marks}</span> : null}
            </span>
            {/* A signed-in player's name leads to their record (not inside a seat button, which is one control). */}
            {seat.handle && !(picking && seat.kind === "open") ? (
              <Link className="place-who" href={`/u/${encodeURIComponent(seat.handle)}`}>
                {occupant(seat)}
              </Link>
            ) : (
              <span className="place-who">{occupant(seat)}</span>
            )}
            {word ? (
              <span className="place-trust">
                <span className="trust-figure">{trustFigure(word)}</span> trust, {trustNote(word)}
              </span>
            ) : null}
            {status ? <span className={`place-state${seat.present || seat.kind === "ai" ? " here" : ""}`}>{status}</span> : null}
          </>
        );
        const classes = `place ${seat.kind}${seat.power === me ? " mine" : ""}${seat.eliminated ? " out" : ""}`;
        if (picking && seat.kind === "open") {
          const chosen = selected === seat.power;
          return (
            <li key={seat.power} className={classes} style={style}>
              <button
                type="button"
                className="place-pick"
                aria-pressed={chosen}
                onClick={() => onSelect(chosen ? null : seat.power)}
              >
                {body}
                <span className="place-take">{chosen ? "Your choice" : "Choose this seat"}</span>
              </button>
            </li>
          );
        }
        return (
          <li key={seat.power} className={classes} style={style}>
            <div className="place-card">{body}</div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The seat strip: seven cells across, one per power in its board colour, each saying in one word
 * what that seat is doing this phase. It is a list, and every cell carries its whole sentence, so
 * the strip is never the only way to read the table. A signed-in player's whole cell leads to their
 * record, so the target is the cell and never a few letters of a name.
 */
import type { PowerName, SeatView } from "@cabal/protocol";
import type { CSSProperties } from "react";
import { Link } from "../app/router.jsx";
import { trustSentence, useTrust } from "../lobby/trust.js";
import { seatState } from "./seatState.js";

const CODE: Record<string, string> = { AUSTRIA: "AUS", ENGLAND: "ENG", FRANCE: "FRA", GERMANY: "GER", ITALY: "ITA", RUSSIA: "RUS", TURKEY: "TUR" };

/** The name under the code: the player, or who plays the seat for nobody. */
function holder(seat: SeatView): string {
  if (seat.kind === "open") return "Open";
  if (seat.kind === "ai") return seat.brain === "claude" ? "Claude" : "Bot";
  return seat.name ?? "Player";
}

export function SeatBar({
  seats,
  me,
  running,
  centres,
  scores,
  place = "side",
}: {
  seats: SeatView[];
  me: PowerName | null;
  running: boolean;
  centres: Record<string, number>;
  /** Once the game is over: each power's share of the result. */
  scores?: Record<string, number> | undefined;
  /** Where it sits: beside the board on a wide screen, over the map on a phone. */
  place?: "side" | "stage";
}) {
  const trust = useTrust(seats.map((s) => s.handle));
  return (
    <ul className={`chairs at-${place}`} aria-label="Seats this phase">
      {seats.map((seat) => {
        const s = seatState(seat, running, scores ? (scores[seat.power] ?? 0) : undefined);
        const word = seat.handle ? trust[seat.handle.toLowerCase()] : undefined;
        const label = `${s.sentence} ${centres[seat.power] ?? 0} supply centres.${word ? ` ${trustSentence(word)}` : ""}${seat.power === me ? " Your seat." : ""}${seat.host ? " Host." : ""}`;
        return (
          <li
            key={seat.power}
            className={`chair tone-${s.tone}${seat.power === me ? " mine" : ""}${seat.handle ? " has-record" : ""}`}
            style={{ "--power": `var(--p-${seat.power.toLowerCase()})` } as CSSProperties}
            title={seat.handle ? `${label} Open ${seat.name ?? seat.handle}'s record.` : label}
          >
            {seat.handle ? (
              <Link className="chair-link" href={`/u/${encodeURIComponent(seat.handle)}`}>
                <span className="sr-only">
                  {label} {seat.name ?? seat.handle}'s record.
                </span>
              </Link>
            ) : (
              <span className="sr-only">{label}</span>
            )}
            <span className="chair-code" aria-hidden="true">
              {CODE[seat.power]}
            </span>
            <span className="chair-sc" aria-hidden="true">
              {centres[seat.power] ?? 0}
            </span>
            <span className="chair-word" aria-hidden="true">
              {s.word}
            </span>
            <span className="chair-name" aria-hidden="true">
              {holder(seat)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

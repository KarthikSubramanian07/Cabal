/**
 * The seat strip: seven cells across, one per power in its board colour, each saying in one word
 * what that seat is doing this phase. It is a list, and every cell carries its whole sentence, so
 * the strip is never the only way to read the table.
 */
import type { PowerName, SeatView } from "@cabal/protocol";
import type { CSSProperties } from "react";
import { seatState } from "./seatState.js";

const CODE: Record<string, string> = { AUSTRIA: "AUS", ENGLAND: "ENG", FRANCE: "FRA", GERMANY: "GER", ITALY: "ITA", RUSSIA: "RUS", TURKEY: "TUR" };

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
  return (
    <ul className={`chairs at-${place}`} aria-label="Seats this phase">
      {seats.map((seat) => {
        const s = seatState(seat, running, scores ? (scores[seat.power] ?? 0) : undefined);
        const label = `${s.sentence} ${centres[seat.power] ?? 0} supply centres.${seat.power === me ? " Your seat." : ""}${seat.host ? " Host." : ""}`;
        return (
          <li
            key={seat.power}
            className={`chair tone-${s.tone}${seat.power === me ? " mine" : ""}`}
            style={{ "--power": `var(--p-${seat.power.toLowerCase()})` } as CSSProperties}
            title={label}
          >
            <span className="sr-only">{label}</span>
            <span className="chair-code" aria-hidden="true">
              {CODE[seat.power]}
            </span>
            <span className="chair-sc" aria-hidden="true">
              {centres[seat.power] ?? 0}
            </span>
            <span className="chair-word" aria-hidden="true">
              {s.word}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

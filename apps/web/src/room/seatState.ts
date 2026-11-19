/**
 * What one seat is doing in the current phase, as a word for the seat strip and a sentence for
 * people who cannot see the strip. Pure, so every combination the server can send is tested.
 */
import type { SeatView } from "@cabal/protocol";
import { powerLabel } from "../lobby/terms.js";

export type SeatTone = "ready" | "in" | "waiting" | "idle" | "away" | "machine" | "disorder" | "out";

export interface SeatState {
  /** One short word for the strip. */
  word: string;
  tone: SeatTone;
  /** The whole story, for the accessible name and the tooltip. */
  sentence: string;
}

function who(seat: SeatView): string {
  if (seat.kind === "ai") return seat.brain === "claude" ? "Claude" : "the bot";
  return seat.name ?? "a player";
}

export function seatState(seat: SeatView, running: boolean, finalScore?: number): SeatState {
  const power = powerLabel(seat.power);
  if (finalScore !== undefined) {
    const share = `${Math.round(finalScore * 100)}%`;
    return finalScore > 0
      ? { word: share, tone: "ready", sentence: `${power}: takes ${share} of the result.` }
      : { word: "0%", tone: "out", sentence: `${power}: takes no share of the result.` };
  }
  if (seat.kind === "open") return { word: "Open", tone: "idle", sentence: `${power}: open seat.` };
  if (seat.eliminated) return { word: "Out", tone: "out", sentence: `${power}: out of the game${seat.kind === "human" ? `, ${who(seat)} watching as a ghost` : ""}.` };
  if (seat.kind === "civil_disorder") {
    return seat.autopilot
      ? { word: "Bot", tone: "disorder", sentence: `${power}: ${who(seat)} missed turns; the bot is covering the seat until they return.` }
      : { word: "C. D.", tone: "disorder", sentence: `${power}: in civil disorder. Its units hold.` };
  }
  if (!running) return seat.present ? { word: "Here", tone: "in", sentence: `${power}: ${who(seat)}, at the table.` } : { word: "Away", tone: "away", sentence: `${power}: ${who(seat)}, away.` };
  const by = seat.kind === "ai" ? `played by ${who(seat)}` : who(seat);
  if (!seat.canAct) return { word: "Rests", tone: "idle", sentence: `${power}, ${by}: nothing to order this phase.` };
  if (seat.ready) return { word: "Ready", tone: "ready", sentence: `${power}, ${by}: orders in and ready.` };
  if (seat.submitted) return { word: "Filed", tone: "in", sentence: `${power}, ${by}: orders in, not ready yet.` };
  if (seat.kind === "ai") return { word: seat.brain === "claude" ? "Claude" : "Bot", tone: "machine", sentence: `${power}, played by ${who(seat)}: deciding.` };
  if (!seat.present) return { word: "Away", tone: "away", sentence: `${power}, ${by}: away, no orders yet.` };
  return { word: "Writing", tone: "waiting", sentence: `${power}, ${by}: at the table, no orders yet.` };
}

/** How many seats that must act this phase are ready: `4 of 6 ready`. */
export function readiness(seats: readonly SeatView[]): { ready: number; acting: number } {
  const acting = seats.filter((s) => !s.eliminated && s.canAct && (s.kind === "human" || s.kind === "ai" || s.autopilot));
  return { ready: acting.filter((s) => s.ready).length, acting: acting.length };
}

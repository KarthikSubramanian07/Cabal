/**
 * The draw vote, read the way the server counts it (apps/server/src/room.ts `vote`): a draw needs
 * a yes from every surviving, present human player this phase. AI seats, seats in civil disorder
 * and eliminated players are never required, so a ghost can never veto. With DIAS the draw is
 * shared by every survivor; without it the voters must agree on who shares, and a survivor who has
 * no vote always shares.
 */
import type { GameSettings, PowerName, SeatView, VotesView } from "@cabal/protocol";
import { powerLabel } from "../lobby/terms.js";

export interface Ballot {
  value: boolean;
  include: PowerName[] | null;
}

/** The viewer's own ballot this phase, if they have cast one and may see it. */
export function myBallot(votes: VotesView | null, me: PowerName | null): Ballot | null {
  const b = votes?.draw.find((d) => d.power === me);
  return b ? { value: b.value, include: b.include } : null;
}

/** Who may vote: a human seat, or an eliminated one when the game lets ghosts speak. */
export function canVote(seat: SeatView | undefined, settings: Pick<GameSettings, "ghostVotes">): boolean {
  if (!seat || seat.kind !== "human") return false;
  return !seat.eliminated || settings.ghostVotes;
}

/** Survivors who have no vote (AI, civil disorder, absent): they must share any draw. */
export function voiceless(seats: readonly SeatView[], votes: Pick<VotesView, "required"> | null): PowerName[] {
  const required = new Set(votes?.required ?? []);
  return seats.filter((s) => !s.eliminated && !required.has(s.power)).map((s) => s.power);
}

export function survivors(seats: readonly SeatView[]): PowerName[] {
  return seats.filter((s) => !s.eliminated).map((s) => s.power);
}

/** The tally in a sentence: `2 of 3 players have voted for a draw.` */
export function tallyLine(votes: VotesView | null): string {
  if (!votes || votes.required.length === 0) return "Nobody at the table has a vote right now.";
  const need = votes.required.length;
  if (votes.yes === 0 && votes.cast === 0) return `No votes yet. A draw needs all ${need} ${need === 1 ? "player" : "players"} at the table.`;
  const against = votes.cast - votes.yes;
  const all = need === 1 ? "you say" : need === 2 ? "both say" : `all ${need} say`;
  return `${votes.yes} of ${need} for a draw${against > 0 ? `, ${against} against` : ""}. It passes when ${all} yes.`;
}

/** How the draw is shared, in one line. */
export function shareLine(settings: Pick<GameSettings, "dias" | "scoring">): string {
  const who = settings.dias ? "Every survivor shares the draw" : "The voters name who shares it; anyone without a vote always shares";
  const how = settings.scoring === "sos" ? "by sum of squares (more centres, larger share)" : "in equal shares";
  return `${who}, ${how}.`;
}

/** A ballot's proposal as words: `everyone still on the board` or `England, France and Italy`. */
export function proposalLine(include: readonly PowerName[] | null): string {
  if (!include) return "everyone still on the board";
  const names = include.map(powerLabel);
  return names.length <= 1 ? (names[0] ?? "nobody") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

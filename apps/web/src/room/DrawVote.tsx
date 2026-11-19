/**
 * The draw vote. A yes or a no for this phase, the tally everyone can see, and who voted when the
 * game shows ballots. Without DIAS a voter also names who shares the draw; a survivor who has no
 * vote (played by AI, in civil disorder, away) is always included, as the server insists.
 */
import type { GameSettings, PowerName, SeatView, VotesView } from "@cabal/protocol";
import { useEffect, useId, useState } from "react";
import { powerLabel } from "../lobby/terms.js";
import { canVote, myBallot, proposalLine, shareLine, survivors, tallyLine, voiceless } from "./votes.js";

export function DrawVote({
  votes,
  seats,
  me,
  settings,
  live,
  onVote,
}: {
  votes: VotesView | null;
  seats: SeatView[];
  me: PowerName | null;
  settings: GameSettings;
  /** The game is running and the socket is open. */
  live: boolean;
  onVote: (value: boolean, include?: PowerName[]) => boolean;
}) {
  const titleId = useId();
  const mine = myBallot(votes, me);
  const seat = seats.find((s) => s.power === me);
  const voter = canVote(seat, settings);
  const ghost = Boolean(seat?.eliminated);
  const alive = survivors(seats);
  const locked = new Set(voiceless(seats, votes));
  const [include, setInclude] = useState<PowerName[]>(() => mine?.include ?? alive);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (mine?.include) setInclude(mine.include);
  }, [mine?.include?.join()]);

  function cast(value: boolean) {
    const named = !settings.dias && value ? [...new Set([...include, ...locked])].filter((p) => alive.includes(p)) : undefined;
    const sent = onVote(value, named && named.length < alive.length ? named : undefined);
    setNote(sent ? null : "Not connected. Your vote was not sent; try again when the table is back.");
  }

  const ballots = votes && !votes.hidden ? votes.draw : [];
  return (
    <section className="draw-vote" aria-labelledby={titleId}>
      <h2 id={titleId}>Draw vote</h2>
      <p className="draw-tally" role="status">
        {tallyLine(votes)}
      </p>
      <p className="fine">{shareLine(settings)}</p>
      {ballots.length > 0 ? (
        <ul className="ballots" aria-label="Ballots this phase">
          {ballots.map((b) => (
            <li key={b.power} className={b.value ? "yes" : "no"}>
              <span className="ballot-power">{powerLabel(b.power)}</span>
              <span className="ballot-value">{b.value ? `for, sharing ${proposalLine(b.include)}` : "against"}</span>
            </li>
          ))}
        </ul>
      ) : votes?.hidden ? (
        <p className="fine">Ballots are secret in this game: you see the tally and your own vote.</p>
      ) : null}
      {voter && live ? (
        <>
          {ghost ? <p className="fine">You are out of the game. Your vote is shown to the table but never decides it.</p> : null}
          {!settings.dias ? (
            <fieldset className="draw-include">
              <legend>Who shares the draw</legend>
              {alive.map((p) => (
                <label key={p} className="check">
                  <input
                    type="checkbox"
                    checked={locked.has(p) || include.includes(p)}
                    disabled={locked.has(p)}
                    onChange={(e) => setInclude((c) => (e.target.checked ? [...c, p] : c.filter((x) => x !== p)))}
                  />
                  <span>
                    {powerLabel(p)}
                    {locked.has(p) ? <span className="fine"> (no vote, always shares)</span> : null}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="vote-buttons">
            <button type="button" className={`btn${mine?.value === true ? " brass" : ""}`} aria-pressed={mine?.value === true} onClick={() => cast(true)}>
              Vote for a draw
            </button>
            <button type="button" className="btn" aria-pressed={mine?.value === false} onClick={() => cast(false)}>
              Vote against
            </button>
          </div>
          <p className="fine">{mine ? `You voted ${mine.value ? "for" : "against"} this phase. You can change it until the phase resolves.` : "Votes last for this phase only."}</p>
        </>
      ) : !me ? (
        <p className="fine">Spectators see the tally; only the players vote.</p>
      ) : null}
      {note ? (
        <p className="form-error" role="alert">
          {note}
        </p>
      ) : null}
    </section>
  );
}

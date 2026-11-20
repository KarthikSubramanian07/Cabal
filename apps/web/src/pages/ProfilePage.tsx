/**
 * A player's record at `/u/:handle`: their rating and its path through their recent games, how
 * dependably they order, their trust ledger (promises kept, broken and void across every game),
 * and their recent games, each with a link to its replay. Public: anyone may look anyone up.
 */
import type { MyGame, PlayerProfile, RatingHistoryResponse } from "@cabal/protocol";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { PageLoading } from "../app/PageLoading.jsx";
import { applyHead, metaFor } from "../app/meta.js";
import { StatusPage } from "../app/StatusPage.jsx";
import { Link } from "../app/router.jsx";
import { powerLabel } from "../lobby/terms.js";
import { ApiError, api, failureText } from "../net/api.js";
import { spacedCode } from "../net/code.js";
import { useIdentity } from "../profile/Identity.jsx";
import { PlayerSeal } from "../profile/ProfileMenu.jsx";
import { RatingChart } from "../profile/RatingChart.jsx";
import { readPlayer } from "../net/player.js";
import { friendlyGames, percent, ratingPath, reliabilityLine, resultWord, signed, tableState, trustLine, withOwnCodes } from "../profile/record.js";

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; profile: PlayerProfile; own: MyGame[] | null; history: RatingHistoryResponse | null };

function month(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function Rating({ profile, history }: { profile: PlayerProfile; history: RatingHistoryResponse | null }) {
  const r = profile.rating;
  const path = ratingPath(history);
  return (
    <section className="file-rating" aria-labelledby="rating-title">
      <h2 id="rating-title">Rating</h2>
      {r ? (
        <>
          <p className="file-figure">
            <strong>{Math.round(r.rating)}</strong>
            <span>
              give or take {Math.round(2 * r.rd)}. {r.games} rated {r.games === 1 ? "game" : "games"}.{" "}
              {r.established && r.rank ? `Ranked ${r.rank} on the ladder.` : "Not on the ladder until the rating settles: a few more rated games."}
            </span>
          </p>
          {path.length >= 2 ? <RatingChart points={path} more={history?.more ?? false} /> : null}
        </>
      ) : (
        <p className="file-empty">No rated game yet. A game is rated when it is public, ends in a win or a draw after two full years, and has at least three signed-in players.</p>
      )}
    </section>
  );
}

function Reliability({ profile }: { profile: PlayerProfile }) {
  const r = profile.reliability;
  const due = Math.max(1, r.phasesDue);
  const segments: [string, number, string][] = [
    ["on time", r.phasesOnTime, "on-time"],
    ["late", r.phasesLate, "late"],
    ["missed", r.missed, "missed"],
  ];
  return (
    <section className="file-reliability" aria-labelledby="reliability-title">
      <h2 id="reliability-title">Reliability</h2>
      <p className="file-figure">
        <strong>{percent(r.score)}</strong>
        <span>{reliabilityLine(r)}</span>
      </p>
      {r.phasesDue > 0 ? (
        <div className="punch" aria-hidden="true">
          {segments.map(([label, n, cls]) =>
            n > 0 ? <span key={label} className={`punch-${cls}`} style={{ flexGrow: n / due }} title={`${n} ${label}`} /> : null,
          )}
        </div>
      ) : null}
    </section>
  );
}

function Trust({ profile, mine }: { profile: PlayerProfile; mine: boolean }) {
  const t = profile.trust;
  const none = t.kept + t.broken + t.void === 0;
  return (
    <section className="file-trust" aria-labelledby="trust-title">
      <h2 id="trust-title">The Ledger</h2>
      <p className="file-figure">
        <strong>{percent(t.score)}</strong>
        <span>{trustLine(t)}</span>
      </p>
      <ul className="trust-stamps" aria-label="Promises on the record">
        <li className="kept">
          <span className="stamp-count">{t.kept}</span> kept
        </li>
        <li className="broken">
          <span className="stamp-count">{t.broken}</span> broken
        </li>
        <li className="void">
          <span className="stamp-count">{t.void}</span> void
        </li>
      </ul>
      <p className="fine file-rule">
        {none && mine && profile.games.played > 0
          ? "Your games so far were at friendly tables, so their seals stay on each table's own Ledger. "
          : ""}
        Seals count here from rated games only, and only promises made to other people.
      </p>
    </section>
  );
}

function OwnTables({ games }: { games: MyGame[] }) {
  if (games.length === 0) return null;
  return (
    <section className="file-recent file-own" aria-labelledby="own-title">
      <h2 id="own-title">Your tables</h2>
      <p className="fine">Only you see this list: every table you sit at, listed or unlisted, on any device signed in to your account.</p>
      <table className="ledger-table">
        <caption className="sr-only">Your tables, most recently joined first</caption>
        <thead>
          <tr>
            <th scope="col">Table</th>
            <th scope="col">Power</th>
            <th scope="col">State</th>
            <th scope="col">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {games.map((g) => (
            <tr key={g.gameId}>
              <th scope="row">{spacedCode(g.gameId)}</th>
              <td data-label="Power">
                <span className="power-mark" style={{ background: `var(--p-${g.power.toLowerCase()})` } as CSSProperties} aria-hidden="true" /> {powerLabel(g.power)}
              </td>
              <td data-label="State">{tableState(g)}</td>
              <td className="action-cell">
                {g.status === "playing" ? (
                  <Link className="btn small" href={`/g/${g.gameId}`} aria-label={`Return to table ${spacedCode(g.gameId)}`}>
                    Return
                  </Link>
                ) : (
                  <Link className="btn small" href={`/replay/${g.gameId}`} aria-label={`Replay the game ${g.gameId}`}>
                    Replay
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Recent({ profile, mine }: { profile: PlayerProfile; mine: boolean }) {
  // A player sees their own friendly games here; anyone else sees how many are left out.
  const hidden = mine ? 0 : friendlyGames(profile.games.played, profile.recent.length);
  const hiddenLine = hidden ? (
    <p className="fine file-rule">
      {hidden === 1 ? "One more game" : `${hidden} more games`} at friendly tables {hidden === 1 ? "is" : "are"} kept off the public record.
    </p>
  ) : null;
  if (profile.recent.length === 0) {
    return (
      <section className="file-recent" aria-labelledby="recent-title">
        <h2 id="recent-title">Recent games</h2>
        {hiddenLine ?? (
          <p className="file-empty">
            No finished games yet. <Link href="/games">Find a table</Link>, or play against six bots from the <Link href="/">front door</Link>.
          </p>
        )}
      </section>
    );
  }
  return (
    <section className="file-recent" aria-labelledby="recent-title">
      <h2 id="recent-title">Recent games</h2>
      {mine ? <p className="fine">Your games at friendly tables are listed for you alone; anyone else sees only your public ones.</p> : null}
      <table className="ledger-table">
        <caption className="sr-only">{profile.player.handle}&apos;s recent games, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Result</th>
            <th scope="col">Power</th>
            <th scope="col">Centres</th>
            <th scope="col">Rating</th>
            <th scope="col">Ended</th>
            <th scope="col">
              <span className="sr-only">Replay</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {profile.recent.map((g, i) => (
            <tr key={`${g.gameId ?? "hidden"}-${i}`}>
              <th scope="row" className={`result-${resultWord(g).toLowerCase()}`}>
                {resultWord(g)}
                {g.substitute ? <span className="fine"> (substitute)</span> : null}
              </th>
              <td data-label="Power">
                <span className="power-mark" style={{ background: `var(--p-${g.power.toLowerCase()})` } as CSSProperties} aria-hidden="true" /> {powerLabel(g.power)}
              </td>
              <td data-label="Centres">{g.centers}</td>
              <td data-label="Rating">{g.ratingDelta === null ? <span className="fine">Unrated</span> : signed(g.ratingDelta, 1)}</td>
              <td data-label="Ended">{day(g.finishedAt)}</td>
              <td className="action-cell">
                {g.gameId ? (
                  <Link className="btn small" href={`/replay/${g.gameId}`} aria-label={`Replay the game ${g.gameId}`}>
                    Replay
                  </Link>
                ) : (
                  <span className="fine">Unlisted</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hiddenLine}
    </section>
  );
}

export default function ProfilePage({ handle }: { handle: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const { player, openAccount } = useIdentity();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    (async () => {
      // The chart is drawn from the stored history; a history that fails to load only costs the chart.
      const [profile, history] = await Promise.all([api.profile(handle), api.ratingHistory(handle).catch(() => null)]);
      // On their own record a player also sees every table they sit at, listed or not.
      const me = readPlayer();
      if (me && me.id === profile.player.id) {
        // Their own file from the account, which lists their friendly games as well.
        const [own, file] = await Promise.all([api.myGames(me.secret).catch(() => [] as MyGame[]), api.me(me.secret).catch(() => null)]);
        return { profile: { ...profile, recent: withOwnCodes(file?.recent ?? profile.recent, own) }, own, history };
      }
      return { profile, own: null, history };
    })().then(
      ({ profile, own, history }) => live && setLoad({ kind: "ready", profile, own, history }),
      (error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) setLoad({ kind: "missing" });
        else setLoad({ kind: "failed", message: failureText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [handle, attempt]);

  // Name the page with the handle as its owner writes it, once it is known.
  const shownHandle = load.kind === "ready" ? load.profile.player.handle : null;
  useEffect(() => {
    if (!shownHandle) return;
    // Every spelling of the handle in the address shares the one its owner writes, as at the edge.
    applyHead(metaFor(`/u/${encodeURIComponent(shownHandle)}`));
    heading.current?.focus();
  }, [shownHandle]);

  if (load.kind === "loading") return <PageLoading />;
  if (load.kind === "missing") {
    return (
      <StatusPage
        stamp="Unknown"
        eyebrow="Player"
        title="Nobody goes by that handle."
        pageTitle={handle}
        actions={
          <>
            <Link className="btn brass" href="/ledger">
              Look through the Ledger
            </Link>
            <Link className="btn" href="/games">
              The games room
            </Link>
          </>
        }
      >
        <p>Check the spelling with whoever sent it. A player who changed their handle can still be found under their old one for a while.</p>
      </StatusPage>
    );
  }
  if (load.kind === "failed") {
    return (
      <StatusPage
        stamp="No answer"
        tone="alert"
        eyebrow="Player"
        title="The record did not load."
        pageTitle={handle}
        actions={
          <button type="button" className="btn brass" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        }
      >
        <p>{load.message}</p>
      </StatusPage>
    );
  }

  const p = load.profile;
  const mine = player?.id === p.player.id;
  return (
    <main className="file-page" id="main" tabIndex={-1}>
      <header className="file-head">
        <PlayerSeal handle={p.player.handle} size={64} />
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {p.player.handle}
          </h1>
          <p className="file-since">
            On Cabal since {month(p.player.createdAt)}. {p.games.played} {p.games.played === 1 ? "game" : "games"} played
            {p.games.played ? `: ${p.games.solos} won outright, ${p.games.draws} drawn.` : "."}
          </p>
        </div>
        {mine ? (
          <button type="button" className="btn" onClick={() => openAccount("handle")}>
            Your account
          </button>
        ) : null}
      </header>
      <div className={`file-grid${p.rating ? "" : " unrated"}`}>
        <Rating profile={p} history={load.history} />
        <Reliability profile={p} />
        <Trust profile={p} mine={mine} />
      </div>
      {load.own ? <OwnTables games={load.own} /> : null}
      <Recent profile={p} mine={mine} />
    </main>
  );
}

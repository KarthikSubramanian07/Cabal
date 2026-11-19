/**
 * The Ledger at `/ledger`: Cabal's two standings. Trust ranks players by the promises they kept
 * and broke across every rated game; Rating ranks them by results. Both are public and paged.
 */
import type { LeaderboardResponse, TrustLeaderboardResponse } from "@cabal/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, navigate } from "../app/router.jsx";
import { api, failureText } from "../net/api.js";
import { useIdentity } from "../profile/Identity.jsx";
import { percent } from "../profile/record.js";

type Board = "trust" | "rating";
const PAGE = 50;

type Rows<T> = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; entries: T[]; next: number | null; more: boolean };

function usePaged<T>(fetchPage: (offset: number) => Promise<{ entries: T[]; next: number | null }>, active: boolean): [Rows<T>, () => void, () => void] {
  const [rows, setRows] = useState<Rows<T>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    if (!active) return;
    let live = true;
    setRows({ kind: "loading" });
    fetchPage(0).then(
      (page) => live && setRows({ kind: "ready", entries: page.entries, next: page.next, more: false }),
      (error: unknown) => live && setRows({ kind: "failed", message: failureText(error) }),
    );
    return () => {
      live = false;
    };
  }, [fetchPage, active, attempt]);

  const more = useCallback(() => {
    if (rows.kind !== "ready" || rows.next === null || busy.current) return;
    busy.current = true;
    setRows({ ...rows, more: true });
    fetchPage(rows.next).then(
      (page) => setRows({ kind: "ready", entries: [...rows.entries, ...page.entries], next: page.next, more: false }),
      () => setRows({ ...rows, more: false }),
    ).finally(() => {
      busy.current = false;
    });
  }, [rows, fetchPage]);

  return [rows, more, () => setAttempt((n) => n + 1)];
}

const trustPage = (offset: number) => api.trustLedger({ offset, limit: PAGE });
const ratingPage = (offset: number) => api.leaderboard({ offset, limit: PAGE });

function Empty({ board }: { board: Board }) {
  return (
    <div className="ledger-empty">
      <p className="stamp" aria-hidden="true">
        Blank page
      </p>
      <p>
        {board === "trust"
          ? "Nobody is on the Ledger yet. A promise goes on the record when it is sealed to another signed-in player, in a public game that is played to a win or a draw over two full years with three or more signed-in players."
          : "Nobody is on the ladder yet. A rating joins it after a few rated games, once it has settled."}
      </p>
      <Link className="btn brass" href="/games">
        Find a table
      </Link>
    </div>
  );
}

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="room-failed" role="alert">
      <p>{message}</p>
      <button type="button" className="btn" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

function More({ next, busy, onMore }: { next: number | null; busy: boolean; onMore: () => void }) {
  if (next === null) return null;
  return (
    <button type="button" className="btn ledger-more" onClick={onMore} disabled={busy}>
      {busy ? "Turning the page" : "Next page"}
    </button>
  );
}

function TrustTable({ rows, me, more, retry }: { rows: Rows<TrustLeaderboardResponse["entries"][number]>; me: string | null; more: () => void; retry: () => void }) {
  if (rows.kind === "loading") return <p className="room-wait" role="status">Reading the Ledger</p>;
  if (rows.kind === "failed") return <Failed message={rows.message} retry={retry} />;
  if (rows.entries.length === 0) return <Empty board="trust" />;
  return (
    <>
      <table className="ledger-table standings-table">
        <caption className="sr-only">Players by trust, most trustworthy first</caption>
        <thead>
          <tr>
            <th scope="col">Place</th>
            <th scope="col">Player</th>
            <th scope="col">Trust</th>
            <th scope="col">Kept</th>
            <th scope="col">Broken</th>
            <th scope="col">Void</th>
            <th scope="col">Games</th>
          </tr>
        </thead>
        <tbody>
          {rows.entries.map((e) => (
            <tr key={e.player.id} aria-current={e.player.id === me ? "true" : undefined}>
              <td className="place">{e.rank}</td>
              <th scope="row">
                <Link href={`/u/${encodeURIComponent(e.player.handle)}`}>{e.player.handle}</Link>
                {e.player.id === me ? <span className="you"> (you)</span> : null}
              </th>
              <td data-label="Trust" className="figure">
                {percent(e.trust.score)}
              </td>
              <td data-label="Kept" className="kept">
                {e.trust.kept}
              </td>
              <td data-label="Broken" className="broken">
                {e.trust.broken}
              </td>
              <td data-label="Void">{e.trust.void}</td>
              <td data-label="Games">{e.games}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <More next={rows.next} busy={rows.more} onMore={more} />
    </>
  );
}

function RatingTable({ rows, me, more, retry }: { rows: Rows<LeaderboardResponse["entries"][number]>; me: string | null; more: () => void; retry: () => void }) {
  if (rows.kind === "loading") return <p className="room-wait" role="status">Reading the ladder</p>;
  if (rows.kind === "failed") return <Failed message={rows.message} retry={retry} />;
  if (rows.entries.length === 0) return <Empty board="rating" />;
  return (
    <>
      <table className="ledger-table standings-table">
        <caption className="sr-only">Players by rating, best first</caption>
        <thead>
          <tr>
            <th scope="col">Place</th>
            <th scope="col">Player</th>
            <th scope="col">Rating</th>
            <th scope="col">Give or take</th>
            <th scope="col">Games</th>
          </tr>
        </thead>
        <tbody>
          {rows.entries.map((e) => (
            <tr key={e.player.id} aria-current={e.player.id === me ? "true" : undefined}>
              <td className="place">{e.rank}</td>
              <th scope="row">
                <Link href={`/u/${encodeURIComponent(e.player.handle)}`}>{e.player.handle}</Link>
                {e.player.id === me ? <span className="you"> (you)</span> : null}
              </th>
              <td data-label="Rating" className="figure">
                {Math.round(e.rating)}
              </td>
              <td data-label="Give or take">{Math.round(2 * e.rd)}</td>
              <td data-label="Games">{e.games}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <More next={rows.next} busy={rows.more} onMore={more} />
    </>
  );
}

export default function LedgerPage() {
  const { player } = useIdentity();
  const [board, setBoard] = useState<Board>(() => (new URLSearchParams(window.location.search).get("by") === "rating" ? "rating" : "trust"));
  const [trust, moreTrust, retryTrust] = usePaged(trustPage, board === "trust");
  const [rating, moreRating, retryRating] = usePaged(ratingPage, board === "rating");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => heading.current?.focus(), []);

  const pick = (next: Board) => {
    setBoard(next);
    navigate(next === "rating" ? "/ledger?by=rating" : "/ledger", { replace: true });
  };

  return (
    <main className="ledger-page" id="main" tabIndex={-1}>
      <header className="ledger-head">
        <h1 ref={heading} tabIndex={-1}>
          The Ledger
        </h1>
        <p className="room-lede">
          Every promise sealed at a Cabal table is opened when its phase resolves and stamped kept, broken or void. Here is who keeps their word, and, for comparison, who wins.
        </p>
      </header>
      <div className="ledger-tabs" role="tablist" aria-label="Standings">
        <button type="button" role="tab" id="tab-trust" aria-selected={board === "trust"} aria-controls="panel-standings" onClick={() => pick("trust")}>
          By trust
        </button>
        <button type="button" role="tab" id="tab-rating" aria-selected={board === "rating"} aria-controls="panel-standings" onClick={() => pick("rating")}>
          By rating
        </button>
      </div>
      <section role="tabpanel" id="panel-standings" aria-labelledby={`tab-${board}`} className="ledger-panel">
        {board === "trust" ? (
          <>
            <p className="fine ledger-how">
              Trust is (kept + 5) ÷ (kept + broken + 10): everyone starts at 50%, and one promise cannot make or ruin a name. Void promises are shown but count for nothing.
            </p>
            <TrustTable rows={trust} me={player?.id ?? null} more={moreTrust} retry={retryTrust} />
          </>
        ) : (
          <>
            <p className="fine ledger-how">
              Ratings are weighted Glicko-2 from every pair of players in a rated game. The ladder lists a rating once it has settled, ordered by rating less twice its uncertainty.
            </p>
            <RatingTable rows={rating} me={player?.id ?? null} more={moreRating} retry={retryRating} />
          </>
        )}
      </section>
    </main>
  );
}

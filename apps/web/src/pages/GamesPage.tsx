/**
 * The games room: the player's seats (this browser's, and for a signed-in player every seat their
 * account holds, from any device), public tables waiting for players, and public
 * games in play, all from `GET /api/games`. A table is joined by its row, by code, or by a
 * pasted link; a new one is set from the create dialog.
 */
import type { GameListing } from "@cabal/protocol";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, navigate } from "../app/router.jsx";
import { CreateGameDialog } from "../lobby/CreateGameDialog.jsx";
import { SeatStrip } from "../lobby/SeatStrip.jsx";
import { ago, phaseLabel, powerLabel, shortTerms, timeLeft } from "../lobby/terms.js";
import { api, failureText } from "../net/api.js";
import { parseGameCode, spacedCode } from "../net/code.js";
import { listSeats } from "../net/seats.js";
import { type ListedSeat, yourSeats } from "../lobby/yourSeats.js";
import { usePlayer } from "../profile/usePlayer.js";
import type { MyGame } from "@cabal/protocol";

/** How often the lists refresh while the page is in view. */
const REFRESH_MS = 15_000;

type Lists = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; open: GameListing[]; active: GameListing[]; at: number };

function useListings(): [Lists, () => void] {
  const [lists, setLists] = useState<Lists>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    Promise.all([api.listLive("open", { limit: 50 }), api.listLive("active", { limit: 50 })]).then(
      ([open, active]) => live && setLists({ kind: "ready", open, active, at: Date.now() }),
      // A failed refresh keeps the last good lists on screen.
      (error: unknown) => live && setLists((current) => (current.kind === "ready" ? current : { kind: "failed", message: failureText(error) })),
    );
    return () => {
      live = false;
    };
  }, [tick]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return [lists, refresh];
}

function JoinByCode() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const noteId = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    const code = parseGameCode(value);
    if (!code) {
      setError("That is not a table code. Codes are six letters and digits, like K7Q 2XZ, or paste the whole link.");
      input.current?.focus();
      return;
    }
    setError(null);
    navigate(`/g/${code}`);
  }

  return (
    <form className="join-code" onSubmit={submit} noValidate>
      <label htmlFor="join-code">Have a code or a link?</label>
      <div className="join-code-row">
        <input
          ref={input}
          id="join-code"
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="K7Q 2XZ"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? noteId : undefined}
        />
        <button type="submit" className="btn">
          Go to table
        </button>
      </div>
      {error ? (
        <p className="form-error" id={noteId} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function ListingTable({ caption, games, kind, now }: { caption: string; games: GameListing[]; kind: "open" | "active"; now: number }) {
  return (
    <table className="ledger-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Table</th>
          <th scope="col">Host</th>
          <th scope="col">Terms</th>
          <th scope="col">Seats</th>
          <th scope="col">{kind === "open" ? "Opened" : "Phase"}</th>
          <th scope="col">
            <span className="sr-only">Action</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {games.map((g) => (
          <tr key={g.gameId}>
            <th scope="row" className="code-cell">
              <Link href={`/g/${g.gameId}`}>{spacedCode(g.gameId)}</Link>
            </th>
            <td data-label="Host">{g.hostName ?? "Unnamed"}</td>
            <td data-label="Terms">{shortTerms(g.settings)}</td>
            <td data-label="Seats">
              <SeatStrip humans={g.humans} open={g.openSeats} />
            </td>
            <td data-label={kind === "open" ? "Opened" : "Phase"}>
              {kind === "open" ? (
                ago(g.createdAt, now)
              ) : (
                <>
                  {phaseLabel(g.phase)}
                  {g.status === "paused" ? <span className="fine"> (paused)</span> : g.deadlineAt ? <span className="fine">, {timeLeft(g.deadlineAt, now)} left</span> : null}
                </>
              )}
            </td>
            <td className="action-cell">
              <Link className="btn small" href={`/g/${g.gameId}`} aria-label={`${kind === "open" ? "Sit down at" : "Watch"} table ${spacedCode(g.gameId)}`}>
                {kind === "open" ? "Sit down" : "Watch"}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The account's own games, for a signed-in player; null until read, or when signed out. */
function useAccountGames(): MyGame[] | null {
  const player = usePlayer();
  const secret = player?.secret ?? null;
  const [games, setGames] = useState<MyGame[] | null>(null);
  useEffect(() => {
    setGames(null);
    if (!secret) return;
    let live = true;
    api.myGames(secret).then(
      (g) => live && setGames(g),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [secret]);
  return games;
}

function YourSeats({ seats }: { seats: ListedSeat[] }) {
  if (seats.length === 0) return null;
  return (
    <section className="room-section" aria-labelledby="your-seats">
      <h2 id="your-seats">Your seats</h2>
      <ul className="held-seats">
        {seats.map((s) => (
          <li key={s.gameId}>
            <Link href={`/g/${s.gameId}`}>
              <span className="power-mark" style={{ background: `var(--p-${s.power.toLowerCase()})` }} aria-hidden="true" />
              <span className="held-code">{spacedCode(s.gameId)}</span>
              <span className="held-detail">
                {powerLabel(s.power)}, as {s.name || "you"}
                {s.elsewhere ? <span className="fine"> (from another device)</span> : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function GamesPage() {
  const [lists, refresh] = useListings();
  const [creating, setCreating] = useState(false);
  const [held] = useState(listSeats);
  const player = usePlayer();
  const accountGames = useAccountGames();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const before = document.title;
    document.title = "Games — Cabal";
    heading.current?.focus();
    return () => {
      document.title = before;
    };
  }, []);

  return (
    <main className="room-page" id="main" tabIndex={-1}>
      <header className="room-head">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            The games room
          </h1>
          <p className="room-lede">Take a seat at an open table, watch a game in play, or set a table of your own and send the code to six friends.</p>
        </div>
        <div className="room-actions">
          <button type="button" className="btn brass big" onClick={() => setCreating(true)}>
            Set a new table
          </button>
          <JoinByCode />
        </div>
      </header>

      <YourSeats seats={yourSeats(held, accountGames, player?.handle ?? null)} />

      {lists.kind === "loading" ? (
        <p className="room-wait" role="status">
          Reading the tables
        </p>
      ) : lists.kind === "failed" ? (
        <div className="room-failed" role="alert">
          <p>{lists.message}</p>
          <button type="button" className="btn" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <section className="room-section" aria-labelledby="open-tables">
            <h2 id="open-tables">Open tables</h2>
            {lists.open.length === 0 ? (
              <p className="room-empty">
                No public table is waiting for players. Set one, and it appears here for anyone to join.
              </p>
            ) : (
              <ListingTable caption="Open tables" games={lists.open} kind="open" now={lists.at} />
            )}
          </section>
          <section className="room-section" aria-labelledby="in-play">
            <h2 id="in-play">In play</h2>
            {lists.active.length === 0 ? (
              <p className="room-empty">No public game is being played right now.</p>
            ) : (
              <ListingTable caption="Games in play" games={lists.active} kind="active" now={lists.at} />
            )}
          </section>
        </>
      )}

      <CreateGameDialog open={creating} onClose={() => setCreating(false)} />
    </main>
  );
}

/**
 * One table at `/g/:code`. Before the game: the lobby, with the seating plan as the seat picker,
 * the terms, the host's Start, and table talk. Once it runs: the game room (room/LiveTable.tsx),
 * with the board, the seat's orders, press with seals, the draw vote and, at the end, the Ledger. The seat this device holds comes from localStorage; the
 * link itself carries only the code, so it is safe to share.
 */
import type { PowerName } from "@cabal/protocol";
import { type FormEvent, Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from "react";
import { PageLoading } from "../app/PageLoading.jsx";
import { StatusPage } from "../app/StatusPage.jsx";
import { Link } from "../app/router.jsx";
import { SeatingPlan } from "../lobby/SeatingPlan.jsx";
import { TableTalk } from "../lobby/TableTalk.jsx";
import { type RoomView, canStart, humanSeats, openSeats } from "../lobby/room.js";
import { describeTerms, phaseLabel, powerLabel, timeLeft } from "../lobby/terms.js";
import { type Room, useRoom } from "../lobby/useRoom.js";
import { failureText } from "../net/api.js";
import { isGameCode, spacedCode } from "../net/code.js";
import { NotifyOffer } from "../profile/NotificationsPanel.jsx";
import { useIdentity } from "../profile/Identity.jsx";

const LiveTable = lazy(() => import("../room/LiveTable.jsx").then((m) => ({ default: m.LiveTable })));

function useNow(every = 15_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(t);
  }, [every]);
  return now;
}

function usePageTitle(title: string) {
  useEffect(() => {
    const before = document.title;
    document.title = `${title} — Cabal`;
    return () => {
      document.title = before;
    };
  }, [title]);
}

/** Copy the table's link, or hand it to the system share sheet where there is one. */
function ShareBar({ code }: { code: string }) {
  const [said, setSaid] = useState("");
  const link = `${window.location.origin}/g/${code}`;
  const canShare = typeof navigator.share === "function";

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setSaid("Link copied. Send it to the people you want at the table.");
    } catch {
      setSaid(`Copy this link: ${link}`);
    }
  }

  async function share() {
    try {
      await navigator.share({ title: `Cabal table ${spacedCode(code)}`, text: `Take a seat at my Diplomacy table. Code ${spacedCode(code)}.`, url: link });
    } catch {
      // Dismissed: nothing to say.
    }
  }

  return (
    <div className="share">
      <button type="button" className="btn" onClick={copy}>
        Copy link
      </button>
      {canShare ? (
        <button type="button" className="btn" onClick={share}>
          Share
        </button>
      ) : null}
      <span className="share-said" role="status">
        {said}
      </span>
    </div>
  );
}

function Terms({ view }: { view: RoomView }) {
  return (
    <section className="terms" aria-labelledby="terms-title">
      <h2 id="terms-title">Terms of the table</h2>
      <dl>
        {describeTerms(view.settings, view.status !== "lobby").map((t) => (
          <div key={t.name}>
            <dt>{t.name}</dt>
            <dd>{t.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function JoinPanel({ view, selected, onJoin }: { view: RoomView; selected: PowerName | null; onJoin: Room["join"] }) {
  const { player, ensurePlayer } = useIdentity();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const open = openSeats(view);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const me = await ensurePlayer("You are about to take a seat. The table, the Ledger and your record will know you by this name.");
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      await onJoin(me, selected ?? undefined);
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  if (open.length === 0) return <p className="talk-note">Every seat is taken. You can watch and read the table talk.</p>;
  return (
    <form className="join-panel" onSubmit={submit} noValidate aria-describedby={error ? errorId : undefined}>
      <h2>Take a seat</h2>
      <p className="fine">
        Choose an open seat above, or leave it to chance.{" "}
        {player ? `You join as ${player.handle}.` : "You choose a handle as you sit down."}
      </p>
      <div className="join-row">
        <button type="submit" className="btn brass big" disabled={busy}>
          {busy ? "Taking the seat" : selected ? `Sit as ${powerLabel(selected)}` : "Take any open seat"}
        </button>
      </div>
      {error ? (
        <p className="form-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function HostPanel({ view, onStart }: { view: RoomView; onStart: Room["start"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = canStart(view);
  const open = openSeats(view).length;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await onStart();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  const line =
    open === 0
      ? "Every seat is taken."
      : view.settings.aiFill
        ? `Start now and the ${open} open seat${open === 1 ? " is" : "s are"} played by ${view.settings.aiBrain === "claude" ? "Claude" : "the bot"}. Or wait: the game starts by itself when the last seat fills.`
        : check.why;

  return (
    <section className="host-panel" aria-labelledby="host-title">
      <h2 id="host-title">You are the host</h2>
      <p>{line}</p>
      <button type="button" className="btn brass big" onClick={start} disabled={!check.ok || busy}>
        {busy ? "Starting" : "Start the game"}
      </button>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Header({ view, connection }: { view: RoomView; connection: Room["connection"] }) {
  const seated = humanSeats(view).length;
  // Read the clock at every draw: a new deadline must not be measured from a minute-old "now".
  // The page redraws at least every 15 seconds (useNow in Table), so the countdown keeps moving.
  const serverNow = Date.now() + view.clockOffsetMs;
  const stamp =
    view.status === "lobby" ? "Lobby" : view.status === "active" ? "In play" : view.status === "paused" ? "Paused" : view.status === "abandoned" ? "Abandoned" : "Finished";
  let line: string;
  if (view.status === "lobby") line = `Waiting for players. ${seated} of 7 seated.`;
  else if (view.status === "active" || view.status === "paused")
    line = `${phaseLabel(view.phase)}${view.status === "paused" ? ", paused" : view.deadlineAt ? `. ${timeLeft(view.deadlineAt, serverNow)} left to order.` : "."}`;
  else if (view.finished?.result === "solo") line = `${view.finished.winners.map(powerLabel).join(", ")} won outright.`;
  else if (view.finished?.result === "draw") line = `Drawn between ${view.finished.winners.map(powerLabel).join(", ")}.`;
  else line = "This game ended before anyone won.";

  return (
    <header className="table-head">
      <p className={`stamp${view.status === "abandoned" ? " alert" : ""}`} aria-hidden="true">
        {stamp}
      </p>
      <h1 tabIndex={-1} id="table-title">
        <span className="table-label">Table</span> <span className="table-code">{spacedCode(view.gameId)}</span>
      </h1>
      <p className="table-line">
        {line}
        {connection === "waiting" || connection === "connecting" ? <span className="fine"> Reconnecting to the table.</span> : null}
      </p>
      {view.status === "lobby" ? <ShareBar code={view.gameId} /> : null}
    </header>
  );
}

function Table({ room, view }: { room: Room; view: RoomView }) {
  // Redraw every 15 seconds so the countdown in the header keeps moving.
  useNow();
  const [selected, setSelected] = useState<PowerName | null>(null);
  const heading = useRef(false);
  const me = room.seat?.power ?? view.power;
  const lobby = view.status === "lobby";
  const running = view.status === "active" || view.status === "paused";
  const isHost = me !== null && me === view.host && room.seat !== null;
  const names = useMemo(() => Object.fromEntries(view.seats.map((s) => [s.power, s.name])) as Partial<Record<PowerName, string | null>>, [view.seats]);

  // The chosen seat may be taken by somebody else while it is chosen.
  useEffect(() => {
    if (selected && !openSeats(view).some((s) => s.power === selected)) setSelected(null);
  }, [view, selected]);

  useEffect(() => {
    if (heading.current) return;
    heading.current = true;
    document.getElementById("table-title")?.focus();
  }, []);

  return (
    <main className="table-page" id="main" tabIndex={-1}>
      <Header view={view} connection={room.connection} />
      {room.notice ? (
        <p className="notice" role="status">
          {room.notice}
        </p>
      ) : null}
      <div className="table-grid">
        <div className="table-main">
          <section aria-labelledby="seats-title" className="seats-section">
            <h2 id="seats-title">{lobby ? "Seating plan" : "The powers"}</h2>
            {room.seat ? (
              <p className="fine">
                You sit as {powerLabel(room.seat.power)}. Open this table on another device signed in to your account and you are seated there too.
              </p>
            ) : null}
            <SeatingPlan seats={view.seats} me={me} running={running} picking={lobby && !room.seat} selected={selected} onSelect={setSelected} />
          </section>
          {lobby && !room.seat ? <JoinPanel view={view} selected={selected} onJoin={room.join} /> : null}
          {lobby && room.seat ? <NotifyOffer moment="seated" /> : null}
          {lobby && isHost ? <HostPanel view={view} onStart={room.start} /> : null}
          <Terms view={view} />
        </div>
        <TableTalk
          press={view.press}
          names={names}
          me={me}
          canWrite={room.seat !== null && room.connection === "open" && (lobby || (running && view.settings.press !== "gunboat"))}
          readOnlyNote={
            !room.seat
              ? lobby
                ? "Take a seat to talk to the table."
                : "Only players at this table can write here."
              : view.settings.press === "gunboat" && running
                ? "Gunboat: nobody writes once the game has started."
                : room.connection !== "open"
                  ? "Reconnecting. You can write again in a moment."
                  : "Table talk is closed."
          }
          onSay={room.say}
        />
      </div>
      <p className="table-foot">
        <Link href="/games">Back to the games room</Link>
      </p>
    </main>
  );
}

export default function GamePage({ code: raw }: { code: string }) {
  const code = raw.toUpperCase();
  const valid = isGameCode(code);
  usePageTitle(`Table ${spacedCode(code)}`);
  if (!valid) return <MissingTable code={raw} />;
  return <Live code={code} />;
}

function Live({ code }: { code: string }) {
  const room = useRoom(code);
  if (room.load.kind === "loading") return <PageLoading />;
  if (room.load.kind === "missing") return <MissingTable code={code} />;
  if (room.load.kind === "unreachable") {
    return (
      <StatusPage
        stamp="No answer"
        tone="alert"
        eyebrow={`Table ${spacedCode(code)}`}
        title="The game server is not answering."
        pageTitle={`Table ${spacedCode(code)}`}
        actions={
          <>
            <button type="button" className="btn brass" onClick={room.retry}>
              Try again
            </button>
            <Link className="btn" href="/sandbox">
              Open the sandbox
            </Link>
          </>
        }
      >
        <p>{room.load.message}</p>
      </StatusPage>
    );
  }
  const view = room.load.view;
  // Once the game has begun the table becomes the game room: the board, orders, press and seals.
  if (view.status !== "lobby") {
    // The summary has no board; the socket's welcome brings it a moment later.
    if (!view.state) return <PageLoading />;
    return (
      <Suspense fallback={<PageLoading />}>
        <LiveTable room={room} view={view} />
      </Suspense>
    );
  }
  return <Table room={room} view={view} />;
}

function MissingTable({ code }: { code: string }) {
  return (
    <StatusPage
      stamp="Unknown"
      eyebrow={`Table ${code}`}
      title="No table goes by that code."
      pageTitle={`Table ${code}`}
      actions={
        <>
          <Link className="btn brass" href="/games">
            Find a table
          </Link>
          <Link className="btn" href="/sandbox">
            Open the sandbox
          </Link>
        </>
      }
    >
      <p>Check the code with whoever sent it. Codes are six letters and digits, and a table that never filled is cleared after a while.</p>
    </StatusPage>
  );
}

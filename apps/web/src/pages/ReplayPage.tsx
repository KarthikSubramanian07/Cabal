/**
 * A finished game played back at `/replay/:code`, read only. The whole game comes from the
 * server's saved game (`GET /api/games/:id/replay`), replayed through the engine in the browser,
 * and is shown with the sandbox's own phase player: the board plays each phase out, the stepper
 * and scrubber move through the history, Space plays and pauses, and each phase's receipts say
 * why every order went as it did. The end of the game, its scores and the Ledger (every seal
 * opened again on this device) sit beside the board.
 */
import type { GameSummary, PowerName } from "@cabal/protocol";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyHead, metaFor, replayIndexable } from "../app/meta.js";
import { shortcutsEnabled } from "../app/prefs.js";
import { PageLoading } from "../app/PageLoading.jsx";
import { StatusPage } from "../app/StatusPage.jsx";
import { Link } from "../app/router.jsx";
import { PhaseStepper, Results } from "../components/Sidebar.jsx";
import { type State, engineReady } from "../engine.js";
import { phaseLine } from "../game/describe.js";
import { parseOrder } from "../game/notation.js";
import { type Speed, READ_MS, advance, dwell, playFrom } from "../game/replay.js";
import { type PhaseRecord, loadSaved } from "../game/saved.js";
import { trackUnits } from "../game/unitIds.js";
import { powerLabel } from "../lobby/terms.js";
import { Board, type DrawnOrder, type Resolution } from "../map/Board.jsx";
import { type Board as BoardData, loadBoard } from "../map/boardData.js";
import { resolutionLength } from "../motion/choreography.js";
import { prefersReducedMotion } from "../motion/useReducedMotion.js";
import { ApiError, api, failureText } from "../net/api.js";
import { isGameCode, spacedCode } from "../net/code.js";
import { GameOver } from "../room/GameOver.jsx";

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "running"; summary: GameSummary }
  | { kind: "failed"; message: string }
  | { kind: "ready"; summary: GameSummary; history: PhaseRecord[]; final: State; board: BoardData };

function useReplay(code: string, attempt: number): Load {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    (async () => {
      const summary = await api.summary(code);
      if (summary.status !== "finished" && summary.status !== "abandoned") return { kind: "running", summary } as const;
      const [json, board] = await Promise.all([api.replay(code), loadBoard(), engineReady()]);
      const loaded = loadSaved(JSON.stringify(json));
      return { kind: "ready", summary, history: loaded.history, final: loaded.game.state(), board } as const;
    })().then(
      (next) => live && setLoad(next),
      (error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) setLoad({ kind: "missing" });
        else setLoad({ kind: "failed", message: error instanceof ApiError ? failureText(error) : "This game's record could not be played back. The engine did not accept it." });
      },
    );
    return () => {
      live = false;
    };
  }, [code, attempt]);
  return load;
}

function ending(summary: GameSummary): string {
  const f = summary.finished;
  if (!f || f.result === "abandoned") return "Abandoned";
  const names = f.winners.map(powerLabel);
  if (f.result === "solo") return `${names[0]} won outright`;
  return names.length === 7 ? "Drawn among all seven" : `Drawn: ${names.join(", ")}`;
}

function Theatre({ code, summary, history, final, board }: Extract<Load, { kind: "ready" }> & { code: string }) {
  const [viewing, setViewing] = useState<number | null>(history.length > 0 ? 0 : null);
  const [replaying, setReplaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [sheet, setSheet] = useState(false);
  const [settled, setSettled] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => heading.current?.focus(), []);

  const view = useCallback((index: number | null) => {
    setReplaying(false);
    setViewing(index);
  }, []);

  const record = viewing !== null ? history[viewing] : undefined;
  const units = useMemo(() => trackUnits(history, final), [history, final]);
  const given = record ? new Set(Object.values(record.orders).flatMap((o) => Object.values(o))) : null;
  const drawn: DrawnOrder[] = record
    ? record.outcome.results.filter((r) => given!.has(r.order) || (!r.ok && parseOrder(r.order)?.type !== "hold")).map((r) => ({ power: r.power, text: r.order, ok: r.ok }))
    : [];

  const resolution = useMemo<Resolution | undefined>(
    () =>
      record && viewing !== null
        ? {
            key: `${viewing}-${record.phase}`,
            phase: record.phase,
            before: record.state,
            after: record.outcome.next,
            results: record.outcome.results,
            beforeIds: units.phases[viewing],
            afterIds: units.phases[viewing + 1] ?? units.live,
          }
        : undefined,
    [record, viewing, units],
  );

  // Playback, exactly as in the sandbox: each phase plays out, then stays up long enough to read.
  useEffect(() => {
    if (!replaying) return;
    if (viewing === null || !resolution) {
      setReplaying(false);
      return;
    }
    const next = () => setViewing(advance(viewing, history.length));
    if (settled === resolution.key) {
      const timer = window.setTimeout(next, Math.round(READ_MS / speed));
      return () => window.clearTimeout(timer);
    }
    const reduced = prefersReducedMotion();
    const timer = window.setTimeout(next, dwell(resolutionLength(resolution, drawn, reduced), speed, reduced) + 1500);
    return () => window.clearTimeout(timer);
    // `drawn` follows `resolution`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaying, viewing, speed, settled, resolution, history.length]);

  const play = useCallback(() => {
    const from = playFrom(viewing, history.length);
    if (from === null) return;
    setViewing(from);
    setReplaying(true);
  }, [viewing, history.length]);

  // Say where the replay is, for people who cannot see the board move.
  useEffect(() => {
    const text = record ? `${phaseLine(record.phase)} results.` : "The final position.";
    setAnnouncement("");
    const t = window.setTimeout(() => setAnnouncement(text), 50);
    return () => window.clearTimeout(t);
  }, [record]);

  // Keys: Space plays and pauses; the arrows step, as in the sandbox.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const onControl = Boolean(target?.closest("input, select, textarea, button, a, [role='slider']"));
      if (onControl || !shortcutsEnabled()) return;
      if (e.key === " ") {
        e.preventDefault();
        if (replaying) setReplaying(false);
        else play();
      } else if (e.key === "ArrowLeft") {
        const at = viewing ?? history.length;
        if (at > 0) view(at - 1);
      } else if (e.key === "ArrowRight") {
        if (viewing !== null) view(viewing + 1 >= history.length ? null : viewing + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replaying, play, viewing, history.length, view]);

  const centres = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [p, list] of Object.entries(final.centers)) out[p] = list.length;
    return out;
  }, [final]);
  const shownCentres = useMemo(() => {
    const state = record ? record.state : final;
    const out: Record<string, number> = {};
    for (const [p, list] of Object.entries(state.centers)) out[p] = list.length;
    return out;
  }, [record, final]);
  const finalPhase = history.at(-1)?.phase ?? summary.phase;
  const failed = record ? record.outcome.results.filter((r) => !r.ok && r.code !== "disband").length : 0;
  const note = record ? (failed ? `${failed} ${failed === 1 ? "order" : "orders"} failed` : "Every order succeeded") : ending(summary);

  return (
    <>
      <main className="table replay-page" id="main" tabIndex={-1}>
        <h1 className="sr-only" ref={heading} tabIndex={-1}>
          Replay of table {spacedCode(code)}
        </h1>
        <div className="board-wrap">
          <div className="stage">
            <Board
              board={board}
              state={record ? record.state : final}
              orders={drawn}
              standoffs={record?.outcome.standoffs}
              resolution={resolution}
              rate={replaying ? speed : 1}
              onSettled={setSettled}
              ids={record ? units.phases[viewing!] : units.live}
            />
          </div>
          <section className="replay-standing" aria-label={record ? `Supply centres as ${phaseLine(record.phase)} began` : "Supply centres at the end"}>
            <ul>
              {(Object.keys(shownCentres) as PowerName[])
                .sort((a, b) => (shownCentres[b] ?? 0) - (shownCentres[a] ?? 0))
                .map((p) => (
                  <li key={p} style={{ "--power": `var(--p-${p.toLowerCase()})` } as CSSProperties}>
                    <span className="swatch" aria-hidden="true" />
                    {powerLabel(p)} <strong>{shownCentres[p]}</strong>
                  </li>
                ))}
            </ul>
          </section>
        </div>

        <aside className="sidebar" data-open={sheet} aria-label="The replay">
          <button type="button" className="sheet-bar" aria-expanded={sheet} aria-controls="sheet-body" onClick={() => setSheet((o) => !o)}>
            <span className="sheet-title">{record ? phaseLine(record.phase) : "Final position"}</span>
            <span className="sheet-note">{note}</span>
            <span className="sheet-chevron" aria-hidden="true">
              {sheet ? "Close" : "Results"}
            </span>
          </button>
          <div className="sheet-body" id="sheet-body">
            <header className="replay-head">
              <p className="replay-kicker">Replay</p>
              <p className="replay-title">Table {spacedCode(code)}</p>
              <p className="fine">
                {ending(summary)}.{" "}
                {history.length > 0
                  ? `${history.length} ${history.length === 1 ? "phase" : "phases"}, ${phaseLine(history[0]!.phase)} to ${phaseLine(history.at(-1)!.phase)}.`
                  : "It ended before the first phase resolved."}
              </p>
            </header>
            <PhaseStepper
              history={history}
              viewing={viewing}
              livePhase={finalPhase}
              endLabel="Final position"
              onView={view}
              playing={replaying}
              speed={speed}
              onPlay={play}
              onPause={() => setReplaying(false)}
              onSpeed={setSpeed}
            />
            {record ? (
              <Results record={record} names={board.provinces} />
            ) : summary.finished ? (
              <GameOver gameId={summary.id} finished={summary.finished} seats={summary.seats} centres={centres} token={undefined} engineReady />
            ) : null}
            <p className="replay-foot">
              <Link href={`/g/${code}`}>The table&apos;s page</Link>
              <Link href="/ledger">The Ledger</Link>
            </p>
          </div>
        </aside>
      </main>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </>
  );
}

export default function ReplayPage({ code: raw }: { code: string }) {
  const code = raw.toUpperCase();
  const [attempt, setAttempt] = useState(0);
  const valid = isGameCode(code);
  if (!valid) return <MissingReplay code={raw} />;
  return <Loaded code={code} attempt={attempt} retry={() => setAttempt((n) => n + 1)} />;
}

function Loaded({ code, attempt, retry }: { code: string; attempt: number; retry: () => void }) {
  const load = useReplay(code, attempt);
  // A public game's replay may be indexed, as the edge said in the head it served (`replayIndexable`).
  const indexable = load.kind === "ready" && replayIndexable(load.summary);
  useEffect(() => {
    if (indexable) applyHead({ ...metaFor(`/replay/${code}`), index: true });
  }, [indexable, code]);
  if (load.kind === "loading") return <PageLoading />;
  if (load.kind === "missing") return <MissingReplay code={code} />;
  if (load.kind === "running") {
    return (
      <StatusPage
        stamp="In play"
        eyebrow={`Table ${spacedCode(code)}`}
        title="This game is still being played."
        pageTitle={`Replay of table ${spacedCode(code)}`}
        actions={
          <>
            <Link className="btn brass" href={`/g/${code}`}>
              Watch it live
            </Link>
            <Link className="btn" href="/games">
              The games room
            </Link>
          </>
        }
      >
        <p>A replay opens here once the game is over. Until then the table&apos;s own page has the board, the results so far and its own scrubber.</p>
      </StatusPage>
    );
  }
  if (load.kind === "failed") {
    return (
      <StatusPage
        stamp="No answer"
        tone="alert"
        eyebrow={`Table ${spacedCode(code)}`}
        title="The replay did not load."
        pageTitle={`Replay of table ${spacedCode(code)}`}
        actions={
          <>
            <button type="button" className="btn brass" onClick={retry}>
              Try again
            </button>
            <Link className="btn" href="/ledger">
              The Ledger
            </Link>
          </>
        }
      >
        <p>{load.message}</p>
      </StatusPage>
    );
  }
  return <Theatre code={code} {...load} />;
}

function MissingReplay({ code }: { code: string }) {
  return (
    <StatusPage
      stamp="Unknown"
      eyebrow={`Table ${code}`}
      title="No game goes by that code."
      pageTitle={`Replay of table ${code}`}
      actions={
        <>
          <Link className="btn brass" href="/ledger">
            The Ledger
          </Link>
          <Link className="btn" href="/games">
            The games room
          </Link>
        </>
      }
    >
      <p>Check the code with whoever sent it. Codes are six letters and digits.</p>
    </StatusPage>
  );
}

/**
 * The game room at `/g/:code` once the game has started: the board with the seat's own orders,
 * written the way the sandbox writes them; the seat strip; the clock on the server's time; the
 * results of each phase with the engine's reasons; press with Seals; the draw vote; and, at the
 * end, the scores and the Ledger. A spectator gets the same room without the order desk.
 *
 * The layout is the sandbox's (`.table`, `.board-wrap`, `.sidebar`): on a phone the board is the
 * first screen and the sidebar is a sheet docked to the bottom with the phase's main action
 * always in reach.
 */
import type { PowerName } from "@cabal/protocol";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageLoading } from "../app/PageLoading.jsx";
import { shortcutsEnabled } from "../app/prefs.js";
import { OrderEntry, type WriteResult } from "../components/OrderEntry.jsx";
import { OrderList, PhaseStepper, Results, whyKey } from "../components/Sidebar.jsx";
import { explainPhase, explainerFor } from "../game/explain/explain.js";
import { type Draft, type Mode, type Step, canGoByConvoy, click, disbandSelected, holdSelected, setMode, typedOrder, viaAlternative } from "../game/compose.js";
import { choicePrompt, choicesFor, describeOrder, phaseLine } from "../game/describe.js";
import { continueLabel, describePhase, parseOrder, parseUnit, provinceOf, titleCase } from "../game/notation.js";
import type { PhaseRecord } from "../game/saved.js";
import { type Speed, advance, dwell, playFrom } from "../game/replay.js";
import { normaliseTyped, type Suggestion } from "../game/typed.js";
import { trackUnits } from "../game/unitIds.js";
import { Board, type DrawnOrder } from "../map/Board.jsx";
import { resultsTiming } from "../map/motion.js";
import type { RoomView } from "../lobby/room.js";
import { SeatingPlan } from "../lobby/SeatingPlan.jsx";
import { describeTerms, phaseLabel, powerLabel } from "../lobby/terms.js";
import type { Room } from "../lobby/useRoom.js";
import { api } from "../net/api.js";
import { ClockCrier, PhaseClock, SheetClock } from "./Countdown.jsx";
import { DrawVote } from "./DrawVote.jsx";
import { GameOver } from "./GameOver.jsx";
import { mergeRecords, missingPhases, recordsFromReplay } from "./history.js";
import { PressPanel } from "./PressPanel.jsx";
import { SeatBar } from "./SeatBar.jsx";
import { readiness } from "./seatState.js";
import { threadList, totalUnread } from "./threads.js";
import { NotifyOffer } from "../profile/NotificationsPanel.jsx";
import { filedLine } from "./settle.js";
import { useDesk } from "./useDesk.js";

type Tab = "orders" | "press" | "table";

interface Picker {
  x: number;
  y: number;
  title: string;
  key: string;
  options: string[];
  openedAt: number;
  openedBy: { x: number; y: number } | null;
}

const IDLE: Draft = { step: "idle" };

/** The browser's own idea of whether it is online. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

export function LiveTable({ room, view }: { room: Room; view: RoomView }) {
  const me = room.seat ? view.power : null;
  const seat = view.seats.find((s) => s.power === me);
  const running = view.status === "active" || view.status === "paused";
  const over = view.status === "finished" || view.status === "abandoned";
  const canOrder = Boolean(seat && running && !seat.eliminated && view.state);
  const kind = view.phase.endsWith("R") ? "R" : view.phase.endsWith("A") ? "A" : "M";
  const online = useOnline();

  const load = useDesk({
    power: me,
    phase: view.phase,
    state: view.state,
    rulebook: view.settings.rulebook,
    serverOrders: view.orders,
    serverPhase: view.ordersPhase,
    ready: Boolean(seat?.ready),
    canOrder,
    connection: room.connection,
    file: room.setOrders,
    unready: (phase) => room.setReady(phase, false),
  });

  if (load.status === "error") {
    return (
      <main className="table-page" id="main" tabIndex={-1}>
        <p className="notice" role="alert">
          The map or the rules engine did not load. <button type="button" className="btn small" onClick={load.retry}>Try again</button>
        </p>
      </main>
    );
  }
  // The same loading screen as the page's own, box for box, so the footer does not jump while the
  // map and the engine arrive (it was the whole of this page's layout shift).
  if (load.status === "loading") return <PageLoading />;
  return <Floor room={room} view={view} me={me} kind={kind} running={running} over={over} canOrder={canOrder} online={online} desk={load.desk} />;
}

/** Games this visit has readied in; the room can be drawn afresh as a phase resolves. */
const readiedThisVisit = new Set<string>();

function Floor({
  room,
  view,
  me,
  kind,
  running,
  over,
  canOrder,
  online,
  desk,
}: {
  room: Room;
  view: RoomView;
  me: PowerName | null;
  kind: "M" | "R" | "A";
  running: boolean;
  over: boolean;
  canOrder: boolean;
  online: boolean;
  desk: Extract<ReturnType<typeof useDesk>, { status: "ready" }>["desk"];
}) {
  const seat = view.seats.find((s) => s.power === me);
  const [tab, setTab] = useState<Tab>(over ? "table" : me ? "orders" : "press");
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState<Draft>(IDLE);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [announcement, setAnnouncement] = useState("");
  const [saved, setSaved] = useState<PhaseRecord[]>([]);
  /** This seat has readied at least once this visit: the moment notifications are worth offering. */
  const [readied, setReadied] = useState(() => readiedThisVisit.has(view.gameId));
  const boardWrap = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<HTMLInputElement>(null);

  const announce = useCallback((text: string) => {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(text), 50);
  }, []);

  // Arriving at the table (Play now, a link, the lobby turning into the game) leaves focus
  // nowhere: put it on the table's heading, as the lobby does, so a keyboard or screen reader
  // starts here.
  useEffect(() => {
    const at = document.activeElement;
    if (!at || at === document.body) title.current?.focus({ preventScroll: true });
  }, []);

  const view$ = useCallback((index: number | null) => {
    setReplaying(false);
    setViewing(index);
  }, []);

  // ---- history: the server's saved game, and the phases this device saw resolve

  const historyCount = view.history.length;
  // Fetched while some phase cannot be drawn from what this device has; once it can, the results
  // frames carry each new phase and nothing is downloaded again.
  const gap = useMemo(() => missingPhases(saved, view.resolved, view.history.map((h) => h.phase)).length > 0, [saved, view.resolved, view.history]);
  // Reading a saved game takes the rules engine, which arrives after the board.
  const rulesReady = desk.rulesReady;
  useEffect(() => {
    if (historyCount === 0 || !gap || !rulesReady) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api.replay(view.gameId, room.seat?.token).then(
        (json) => {
          if (!live) return;
          try {
            setSaved(recordsFromReplay(JSON.stringify(json)));
          } catch {
            // The frames this device saw still give the latest results.
          }
        },
        () => undefined,
      );
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [view.gameId, historyCount, gap, room.seat?.token, rulesReady]);

  const history = useMemo(
    () => mergeRecords(saved, view.resolved, view.history.map((h) => h.phase)),
    [saved, view.resolved, view.history],
  );

  // A phase has just resolved: show its results on the board.
  const seenResolved = useRef(view.lastResolved);
  useEffect(() => {
    if (view.lastResolved === seenResolved.current) return;
    const index = history.findIndex((r) => r.phase === view.lastResolved);
    if (index < 0) return;
    seenResolved.current = view.lastResolved;
    setDraft(IDLE);
    setPicker(null);
    view$(index);
    const failed = history[index]!.outcome.results.filter((r) => !r.ok && r.code !== "disband").length;
    announce(`${phaseLine(history[index]!.phase)} resolved. ${failed === 0 ? "Every order succeeded." : `${failed} ${failed === 1 ? "order" : "orders"} failed.`}`);
  }, [view.lastResolved, history, view$, announce]);

  useEffect(() => {
    if (viewing !== null && viewing >= history.length) view$(null);
  }, [viewing, history.length, view$]);

  const record = viewing !== null ? history[viewing] : undefined;
  const playing = !record && canOrder;

  // ---- why an order failed: the engine's account of the phase on show

  /** The receipt whose "why" panel is open. */
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  useEffect(() => setWhyOpen(null), [viewing]);
  const places = desk.board.provinces;
  // Re-running a phase to explain it takes the rules engine, which arrives after the board.
  const explainShown = useMemo(
    () => (record && rulesReady ? explainerFor(record.outcome.results, record.phase, explainPhase(record), places) : null),
    [record, rulesReady, places],
  );
  const openWhy = useMemo(() => {
    if (!whyOpen || !record || !explainShown) return null;
    const r = record.outcome.results.find((x, i) => whyKey(x, i) === whyOpen);
    return r ? explainShown(r) : null;
  }, [whyOpen, record, explainShown]);

  // ---- composing, exactly as in the sandbox, for one power

  const ctx = desk.ctx;
  const apply = useCallback(
    (step: Step, client?: { x: number; y: number }) => {
      setDraft(step.draft);
      const effect = step.effect;
      if (effect.kind === "order") {
        desk.setOrder(effect.key, effect.text);
        setMessage(null);
        announce(describeOrder(effect.text));
      } else if (effect.kind === "choose") {
        const rect = boardWrap.current?.getBoundingClientRect();
        const frame = boardWrap.current?.querySelector(".board-frame")?.getBoundingClientRect();
        const half = 100;
        const tall = 34 + effect.options.length * 44;
        const x = client && rect ? client.x - rect.left : rect ? rect.width / 2 : 40;
        const y = client && rect ? client.y - rect.top : rect ? rect.height / 3 : 40;
        const maxY = frame && rect ? frame.bottom - rect.top - tall - 12 : y;
        setPicker({
          x: rect ? Math.min(Math.max(x, half), rect.width - half) : x,
          y: Math.max(0, Math.min(y, maxY)),
          title: effect.title,
          key: effect.key,
          options: effect.options,
          openedAt: performance.now(),
          openedBy: client ?? null,
        });
        setMessage(null);
      } else if (effect.kind === "message") {
        setMessage(effect.text);
        announce(effect.text);
      } else if (step.draft.step !== "idle") {
        setMessage(null);
      }
    },
    [desk, announce],
  );

  const onProvince = useCallback(
    (code: string, client: { x: number; y: number }) => {
      if (!playing) return;
      setPicker(null);
      apply(click(ctx, draft, code), client);
    },
    [ctx, draft, apply, playing],
  );

  const mode = useCallback((m: Mode) => apply(setMode(ctx, draft, m)), [ctx, draft, apply]);
  const cancel = useCallback(() => {
    setDraft(IDLE);
    setPicker(null);
    setMessage(null);
  }, []);

  // A new phase: nothing half written carries over.
  useEffect(() => cancel(), [view.phase, cancel]);

  const targets = useMemo(() => {
    const set = new Set<string>();
    if (draft.step === "idle") return set;
    for (const text of desk.legal[draft.unit] ?? []) {
      const o = parseOrder(text);
      if (!o) continue;
      if (draft.step === "unit" && o.type === "move" && (!draft.via || o.via)) set.add(provinceOf(o.dest));
      if (draft.step === "unit" && o.type === "retreat") set.add(provinceOf(o.dest));
      if (draft.step === "support") {
        if (!draft.target && (o.type === "support-move" || o.type === "support-hold")) set.add(o.target.province);
        if (draft.target && o.type === "support-move" && o.target.unit === draft.target) set.add(provinceOf(o.dest));
        if (draft.target && o.type === "support-hold" && o.target.unit === draft.target) set.add(o.target.province);
      }
      if (draft.step === "convoy") {
        if (!draft.army && o.type === "convoy") set.add(o.army.province);
        if (draft.army && o.type === "convoy" && o.army.unit === draft.army) set.add(provinceOf(o.dest));
      }
    }
    return set;
  }, [desk.legal, draft]);

  const hot = useMemo(() => {
    const set = new Set<string>();
    for (const [unit, options] of Object.entries(desk.legal)) {
      if (unit) {
        const ref = parseUnit(unit);
        if (ref && options.length) set.add(ref.province);
      } else {
        for (const text of options) {
          const o = parseOrder(text);
          if (o?.type === "build" || o?.type === "disband") set.add(o.unit.province);
        }
      }
    }
    return set;
  }, [desk.legal]);

  const focus = useMemo(() => {
    if (!me || !view.state) return undefined;
    const codes = new Set<string>(view.state.centers[me] ?? []);
    for (const u of view.state.units[me] ?? []) {
      const ref = parseUnit(u);
      if (ref) codes.add(ref.province);
    }
    return [...codes];
  }, [view.state, me]);

  const suggestions = useMemo<Suggestion[]>(
    () => (me ? Object.values(desk.legal).flatMap((orders) => orders.map((text) => ({ power: me, text }))) : []),
    [desk.legal, me],
  );

  const writeTyped = useCallback(
    (inputs: string[]): WriteResult => {
      const result: WriteResult = { written: [], refused: [] };
      if (!me) return result;
      const orders = { [me]: { ...desk.book } };
      for (const input of inputs) {
        const verdict = desk.judge(normaliseTyped(input));
        if (!verdict.legal || !verdict.canonical) {
          result.refused.push({ input, reason: verdict.reason });
          continue;
        }
        const step = typedOrder({ ...ctx, orders }, me, verdict.canonical);
        if (step.effect.kind !== "order") {
          result.refused.push({ input, reason: step.effect.kind === "message" ? step.effect.text : verdict.reason });
          continue;
        }
        desk.setOrder(step.effect.key, step.effect.text);
        orders[me] = { ...orders[me], [step.effect.key]: step.effect.text };
        result.written.push(step.effect.text);
      }
      if (result.written.length) setDraft(IDLE);
      return result;
    },
    [me, desk, ctx],
  );

  // ---- keyboard, as in the sandbox

  const play = useCallback(() => {
    const from = playFrom(viewing, history.length);
    if (from === null) return;
    cancel();
    setViewing(from);
    setReplaying(true);
  }, [viewing, history.length, cancel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, select, textarea, dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const onControl = Boolean(el.closest("button, a, [role='button']"));
      if (key === "escape") return cancel();
      if (viewing !== null) {
        if (key === "arrowright") view$(viewing + 1 >= history.length ? null : viewing + 1);
        else if (key === "arrowleft" && viewing > 0) view$(viewing - 1);
        return;
      }
      if (key === "arrowleft" && !onControl && history.length > 0 && draft.step === "idle" && !picker) return view$(history.length - 1);
      if (!playing || !shortcutsEnabled()) return;
      if (key === "m") return mode("move");
      if (key === "s") return mode("support");
      if (key === "c") return mode("convoy");
      if (key === "v") return mode("via-convoy");
      if (key === "h") return apply(holdSelected(ctx, draft));
      if (key === "d") return apply(disbandSelected(ctx, draft));
      if (key === "/" && entryRef.current?.checkVisibility?.()) {
        e.preventDefault();
        entryRef.current.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx, draft, picker, mode, apply, cancel, viewing, history.length, view$, playing]);

  // ---- what the board shows

  const mapState = record ? record.state : (view.state as unknown as PhaseRecord["state"]);
  const given = record ? new Set(Object.values(record.orders).flatMap((o) => Object.values(o))) : null;
  const drawn: DrawnOrder[] = record
    ? record.outcome.results.filter((r) => given!.has(r.order) || (!r.ok && parseOrder(r.order)?.type !== "hold")).map((r) => ({ power: r.power, text: r.order, ok: r.ok }))
    : me
      ? Object.values(desk.book).map((text) => ({ power: me, text }))
      : [];
  const units = useMemo(() => trackUnits(history, view.state as unknown as PhaseRecord["state"]), [history, view.state]);

  const resultsMs = record ? resultsTiming(drawn).total : 0;
  useEffect(() => {
    if (!replaying) return;
    if (viewing === null) {
      setReplaying(false);
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const timer = window.setTimeout(() => setViewing(advance(viewing, history.length)), dwell(resultsMs, speed, reduced));
    return () => window.clearTimeout(timer);
  }, [replaying, viewing, speed, resultsMs, history.length]);

  // ---- press

  const threads = useMemo(() => threadList(view.press, me, view.settings, view.unread), [view.press, me, view.settings, view.unread]);
  const unread = totalUnread(threads);
  const pressVisible = tab === "press" && (sheet || !window.matchMedia?.("(max-width: 1000px)").matches);
  const resultsFor = useCallback((phase: string) => history.find((r) => r.phase === phase)?.outcome.results ?? view.resolved[phase]?.results ?? null, [history, view.resolved]);

  // A private dispatch that arrives while the press is not on screen is said out loud once.
  const heard = useRef(view.press.length);
  useEffect(() => {
    const fresh = view.press.slice(heard.current);
    heard.current = view.press.length;
    const letter = fresh.find((m) => m.from !== me && m.to !== "ALL");
    if (letter && !pressVisible) announce(`New dispatch from ${powerLabel(letter.from)}.`);
  }, [view.press, me, pressVisible, announce]);

  // ---- the clock and the seats

  // The clock itself ticks in its own components (Countdown.tsx): nothing here redraws each second.
  const deadlineAt = running && view.deadlineAt ? view.deadlineAt : null;
  const { ready: readyCount, acting } = readiness(view.seats);
  const centres = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [p, list] of Object.entries(view.state?.centers ?? {})) out[p] = list.length;
    return out;
  }, [view.state]);
  const finalScores = over && view.finished?.result !== "abandoned" ? view.finished?.scores : undefined;
  const names = useMemo(() => Object.fromEntries(view.seats.map((s) => [s.power, s.name])) as Partial<Record<PowerName, string | null>>, [view.seats]);

  // ---- the order desk's figures

  const orderable = Object.keys(desk.legal).filter((u) => u !== "");
  const due = kind === "A" ? Math.abs(desk.allowance) : orderable.length;
  const givenCount = Object.keys(desk.book).length;
  const isReady = Boolean(seat?.ready);
  const inDisorder = seat?.kind === "civil_disorder";

  const toggleReady = async () => {
    if (!me) return;
    if (!isReady && !(await desk.settle())) {
      announce("Your orders could not be filed, so you are not marked ready yet.");
      return;
    }
    const sent = room.setReady(view.phase, !isReady);
    if (sent && !isReady) {
      readiedThisVisit.add(view.gameId);
      setReadied(true);
    }
    if (!sent) announce("Not connected. Try again when the table is back.");
    else announce(isReady ? "You are no longer ready." : "Ready. The phase resolves when every seat is.");
  };

  const shown = describePhase(record ? record.phase : view.phase);
  const live = describePhase(view.phase);
  const syncLine =
    desk.sync === "saving" || desk.sync === "pending"
      ? room.connection === "open"
        ? "Filing your orders."
        : "Your orders are kept on this device and filed when the connection is back."
      : desk.sync === "failed"
        ? desk.syncError
        : filedLine({ kind, allowance: desk.allowance, given: givenCount, due });

  const sheetNote = (() => {
    const parts: ReactNode[] = [];
    if (record) parts.push("Results");
    else if (deadlineAt !== null) parts.push(view.status === "paused" ? "Paused" : <SheetClock key="clock" deadlineAt={deadlineAt} offsetMs={view.clockOffsetMs} />);
    else if (over) parts.push(view.finished?.result === "solo" ? `${powerLabel(view.finished.winners[0] ?? "")} won` : view.finished?.result === "draw" ? "Drawn" : "Abandoned");
    if (!record && me && canOrder && due > 0) parts.push(`${Math.min(givenCount, due)} of ${due} ${kind === "A" ? (desk.allowance > 0 ? "builds" : "disbands") : "orders"}`);
    if (!record && isReady) parts.push("ready");
    if (unread > 0) parts.push(`${unread} unread`);
    return parts.flatMap((part, i) => (i === 0 ? [part] : [", ", part]));
  })();

  const hint: ReactNode = (() => {
    if (record) return "Showing how the phase resolved.";
    if (!me) return "You are watching this game.";
    if (over) return "The game is over.";
    if (!canOrder) return seat?.eliminated ? "You are out of the game. You can still talk and vote." : "Waiting for the board.";
    if (!rulesReady) return "Reading the rules. Your orders open in a moment.";
    if (message) return message;
    if (picker) return `${picker.title}: choose from the menu.`;
    if (due === 0) return kind === "A" ? "Nothing to build or disband this winter." : kind === "R" ? "None of your units has to retreat." : "You have no units to order.";
    switch (draft.step) {
      case "idle":
        return kind === "A" ? "Tap an empty home supply centre to build, or a unit to disband." : kind === "R" ? "Tap a dislodged unit, then where it retreats." : "Tap one of your units, then where it should go.";
      case "unit":
        if (draft.via) return `${draft.unit} by convoy: tap where the fleets should land it.`;
        return kind === "R" ? `${draft.unit}: tap an empty neighbour, or disband it.` : `${draft.unit}: tap a destination, or tap it again to hold.`;
      case "support":
        return draft.target ? `${draft.unit} supports ${draft.target}: tap where it is going, or ${draft.target} again to support it holding.` : `${draft.unit} supports: tap the unit to support.`;
      case "convoy":
        return draft.army ? `${draft.unit} convoys ${draft.army}: tap where it lands.` : `${draft.unit} convoys: tap the army.`;
    }
  })();

  const choices = playing && me ? choicesFor(ctx, draft, me, orderable, targets, desk.board.provinces) : [];
  const convoyable = playing && draft.step === "unit" && me !== null && canGoByConvoy(ctx, draft.power, draft.unit);
  const last = viewing !== null && viewing + 1 >= history.length;
  const rejected = Object.values(desk.verdicts).filter((v) => !v.ok);
  const offline = !online || (room.everOpen && room.connection !== "open" && room.connection !== "closed");

  return (
    <>
      {offline ? (
        <div className="wire-down" role="status">
          <p>
            <strong>{online ? "Connection lost." : "You are offline."}</strong>{" "}
            {canOrder ? "Orders you write are kept here and filed when the line is back." : "The table will catch up when the line is back."}
          </p>
          {online ? (
            <button type="button" className="btn small" onClick={room.reconnect}>
              Reconnect now
            </button>
          ) : null}
        </div>
      ) : room.notice ? (
        <div className="wire-down" role="status">
          <p>{room.notice}</p>
          {room.crowded ? (
            <button type="button" className="btn small" onClick={room.reconnect}>
              Reconnect
            </button>
          ) : null}
        </div>
      ) : null}
      <main className="table live" id="main" tabIndex={-1}>
        <h1 className="sr-only" ref={title} tabIndex={-1}>
          Table {view.gameId}, {phaseLabel(view.phase)}
        </h1>
        <div className="board-wrap" ref={boardWrap}>
          <div className="stage">
            <SeatBar seats={view.seats} me={me} running={running} centres={centres} scores={finalScores} place="stage" />
            <Board
              board={desk.board}
              state={mapState}
              orders={drawn}
              selected={record ? null : draft.step === "idle" ? null : (parseUnit(draft.unit)?.province ?? null)}
              targets={record ? undefined : targets}
              hot={playing ? hot : undefined}
              standoffs={record?.outcome.standoffs}
              results={record ? `${viewing}-${record.phase}` : undefined}
              ids={record ? units.phases[viewing!] : units.live}
              highlight={openWhy?.highlight}
              focus={focus}
              onProvince={onProvince}
            />
            {picker ? (
              <div className="picker" ref={pickerRef} style={{ left: picker.x, top: picker.y }} role="menu" aria-labelledby="picker-title">
                <div className="picker-title" id="picker-title" role="presentation">
                  {picker.title}
                </div>
                {picker.options.map((o) => (
                  <button
                    key={o}
                    type="button"
                    role="menuitem"
                    onClick={(e) => {
                      const from = picker.openedBy;
                      const sameSpot = from !== null && Math.hypot(e.clientX - from.x, e.clientY - from.y) < 16;
                      if (sameSpot && e.timeStamp - picker.openedAt < 700) return;
                      desk.setOrder(picker.key, o);
                      setPicker(null);
                      announce(describeOrder(o));
                    }}
                  >
                    {o}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="toolbar" role="group" aria-label="Order tools">
              {kind === "M" && playing && due > 0 ? (
                <>
                  <button type="button" className="tool" aria-pressed={draft.step === "unit"} onClick={() => mode("move")}>
                    Move <kbd>M</kbd>
                  </button>
                  <button type="button" className="tool" aria-pressed={draft.step === "support"} onClick={() => mode("support")}>
                    Support <kbd>S</kbd>
                  </button>
                  <button type="button" className="tool" aria-pressed={draft.step === "convoy"} onClick={() => mode("convoy")}>
                    Convoy <kbd>C</kbd>
                  </button>
                  {convoyable ? (
                    <button type="button" className="tool" aria-pressed={draft.step === "unit" && Boolean(draft.via)} onClick={() => mode("via-convoy")}>
                      By convoy <kbd>V</kbd>
                    </button>
                  ) : null}
                  <button type="button" className="tool" onClick={() => apply(holdSelected(ctx, draft))}>
                    Hold <kbd>H</kbd>
                  </button>
                </>
              ) : null}
              {kind === "R" && playing && due > 0 ? (
                <button type="button" className="tool" onClick={() => apply(disbandSelected(ctx, draft))}>
                  Disband <kbd>D</kbd>
                </button>
              ) : null}
              {draft.step !== "idle" || picker ? (
                <button type="button" className="tool" onClick={cancel}>
                  Cancel <kbd>Esc</kbd>
                </button>
              ) : null}
              <p className={`hint${message && playing ? " alert" : ""}`} role="status" aria-live="polite">
                {hint}
              </p>
            </div>
          </div>
          {choices.length ? (
            <section className="choices" tabIndex={-1} aria-labelledby="choices-title">
              <h2 id="choices-title">{choicePrompt(kind, draft, draft.step === "idle" ? me! : draft.power)}</h2>
              <div className="choice-list">
                {choices.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    className="tool choice"
                    onClick={() => {
                      setPicker(null);
                      apply(click(ctx, draft, c.code));
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <aside className="sidebar live-side" data-open={sheet} aria-label="The game">
          <button type="button" className="sheet-bar" aria-expanded={sheet} aria-controls="sheet-body" onClick={() => setSheet((o) => !o)}>
            <span className="sheet-title">
              {shown.season} {shown.year}
            </span>
            <span className="sheet-note">{sheetNote}</span>
            <span className="sheet-chevron" aria-hidden="true">
              {sheet ? "Close" : unread > 0 ? `Press ${unread}` : "Open"}
            </span>
          </button>

          <div className="sheet-body" id="sheet-body">
            <header className="live-head">
              <p className="live-table">
                Table <span className="table-code-sm">{view.gameId}</span>
                {me ? <span className="you-as" style={{ "--power": `var(--p-${me.toLowerCase()})` } as CSSProperties}>{powerLabel(me)}</span> : <span className="watching">Watching</span>}
              </p>
              <h2 className="phase-title">
                <span className="season">{live.season}</span> <span className="year">{live.year}</span>
                <span className="sr-only"> {live.kind}</span>
              </h2>
              <div className="phase-meta">
                <span>{over ? (view.finished?.result === "solo" ? `${powerLabel(view.finished.winners[0] ?? "")} won outright` : view.finished?.result === "draw" ? "Drawn" : "Abandoned") : live.kind}</span>
                {running ? <PhaseClock deadlineAt={deadlineAt} offsetMs={view.clockOffsetMs} paused={view.status === "paused"} grace={Boolean(view.grace)} /> : null}
              </div>
              {view.status === "paused" ? <p className="fine">The game is paused{view.pauseReason ? `: ${pauseWords(view.pauseReason)}` : "."}</p> : null}
              {running ? (
                <p className="fine ready-count">
                  {readyCount} of {acting} seats ready.
                </p>
              ) : null}
            </header>
            <SeatBar seats={view.seats} me={me} running={running} centres={centres} scores={finalScores} />
            <PhaseStepper
              history={history}
              viewing={viewing}
              livePhase={view.phase}
              onView={view$}
              playing={replaying}
              speed={speed}
              onPlay={play}
              onPause={() => setReplaying(false)}
              onSpeed={setSpeed}
            />

            <div className="live-tabs" role="tablist" aria-label="The game">
              {(
                [
                  ["orders", me ? (record ? "Results" : "Orders") : record ? "Results" : "Board"],
                  ["press", "Press"],
                  ["table", over ? "Final" : "Table"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`panel-${id}`}
                  className="live-tab"
                  onClick={() => setTab(id)}
                >
                  {label}
                  {id === "press" && unread > 0 ? (
                    <span className="unread">
                      {unread}
                      <span className="sr-only">&nbsp;unread</span>
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            <div role="tabpanel" id="panel-orders" aria-labelledby="tab-orders" hidden={tab !== "orders"} className="live-panel">
              {readied ? <NotifyOffer moment="ready" /> : null}
              {record ? (
                <Results record={record} names={places} explain={explainShown ?? undefined} open={whyOpen} onOpen={setWhyOpen} />
              ) : me && canOrder ? (
                <section>
                  <h2>{titleCase(me)}</h2>
                  {inDisorder ? <p className="notice">Your seat fell into civil disorder after missed turns. Send orders to take it back.</p> : null}
                  <OrderList
                    power={me}
                    kind={kind}
                    units={orderable}
                    orders={desk.book}
                    allowance={desk.allowance}
                    onRemove={desk.removeOrder}
                    alternative={(text) => viaAlternative(ctx, me, text)}
                    onReplace={(key, text) => {
                      desk.setOrder(key, text);
                      announce(describeOrder(text));
                    }}
                  />
                  {rejected.length ? (
                    <ul className="refusals" role="alert">
                      {rejected.map((v) => (
                        <li key={v.text}>
                          <code>{v.text}</code> {v.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="row-actions">
                    {kind === "M" && due > 0 ? (
                      <button type="button" className="btn small" onClick={desk.holdAll}>
                        Hold the rest
                      </button>
                    ) : null}
                    {kind === "A" && desk.allowance > 0 ? (
                      <button type="button" className="btn small" onClick={desk.waive} disabled={givenCount >= desk.allowance}>
                        Waive a build
                      </button>
                    ) : null}
                    {givenCount > 0 ? (
                      <button type="button" className="btn small" onClick={desk.clearOrders}>
                        Clear
                      </button>
                    ) : null}
                  </div>
                  {due > 0 ? <OrderEntry ref={entryRef} legal={suggestions} active={me} onWrite={writeTyped} /> : null}
                </section>
              ) : (
                <section>
                  <h2>The board</h2>
                  <ul className="standings" aria-label="Supply centres">
                    {[...view.seats]
                      .sort((a, b) => (centres[b.power] ?? 0) - (centres[a.power] ?? 0))
                      .map((s) => (
                        <li key={s.power} style={{ "--power": `var(--p-${s.power.toLowerCase()})` } as CSSProperties}>
                          <span className="swatch" aria-hidden="true" />
                          <span>{powerLabel(s.power)}</span>
                          <span className="standing-n">{centres[s.power] ?? 0}</span>
                        </li>
                      ))}
                  </ul>
                  <p className="fine">{me ? "You have nothing to order this phase." : "You are watching. Orders stay secret until each phase resolves; the results appear here when it does."}</p>
                </section>
              )}
            </div>

            <div role="tabpanel" id="panel-press" aria-labelledby="tab-press" hidden={tab !== "press"} className="live-panel">
              <PressPanel
                threads={threads}
                me={me}
                names={names}
                settings={view.settings}
                status={view.status}
                phase={view.phase}
                press={view.press}
                visible={pressVisible}
                myOrders={Object.values(desk.book)}
                resultsFor={resultsFor}
                engineReady={rulesReady}
                connected={room.connection === "open"}
                onSend={room.send}
                onRead={room.markRead}
              />
            </div>

            <div role="tabpanel" id="panel-table" aria-labelledby="tab-table" hidden={tab !== "table"} className="live-panel">
              {over && view.finished ? (
                <GameOver gameId={view.gameId} finished={view.finished} seats={view.seats} centres={centres} token={room.seat?.token} engineReady={rulesReady} />
              ) : null}
              {running ? (
                <DrawVote votes={view.votes} seats={view.seats} me={me} settings={view.settings} live={room.connection === "open" && view.status === "active"} onVote={room.vote} />
              ) : null}
              {running && me && seat && !seat.eliminated ? <Extension room={room} view={view} me={me} /> : null}
              <section className="seats-section">
                <h2>The powers</h2>
                <SeatingPlan seats={view.seats} me={me} running={running} picking={false} selected={null} onSelect={() => undefined} />
              </section>
              <section className="terms">
                <h2>Terms of the table</h2>
                <dl>
                  {describeTerms(view.settings, true).map((t) => (
                    <div key={t.name}>
                      <dt>{t.name}</dt>
                      <dd>{t.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          </div>

          <div className="actions">
            {record ? (
              <button type="button" className="btn primary" onClick={() => view$(last ? null : viewing! + 1)}>
                {last ? (over ? "Back to the final position" : continueLabel(view.phase)) : "Next phase"}
              </button>
            ) : me && canOrder && seat?.canAct ? (
              <button type="button" className={`btn primary${isReady ? " is-ready" : ""}`} aria-pressed={isReady} onClick={toggleReady} disabled={inDisorder || room.connection !== "open" || !rulesReady}>
                {isReady ? "Ready. Take it back" : `Ready for ${phaseLine(view.phase)}`}
              </button>
            ) : over ? (
              <button type="button" className="btn primary" onClick={() => { setTab("table"); setSheet(true); }}>
                See the final scores
              </button>
            ) : !me ? (
              tab === "press" ? (
                <button type="button" className="btn primary" onClick={() => { setTab("table"); setSheet(true); }}>
                  See who sits where
                </button>
              ) : (
                <button type="button" className="btn primary" onClick={() => { setTab("press"); setSheet(true); }}>
                  Read the table talk
                </button>
              )
            ) : (
              <button type="button" className="btn primary" disabled>
                Nothing to order this phase
              </button>
            )}
            {!record && me && canOrder && seat?.canAct ? (
              <p className={`sync-line${desk.sync === "failed" ? " alert" : ""}`} role="status">
                {syncLine}
              </p>
            ) : null}
          </div>
        </aside>
      </main>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <ClockCrier deadlineAt={view.status === "active" ? deadlineAt : null} offsetMs={view.clockOffsetMs} announce={announce} />
    </>
  );
}

function pauseWords(reason: string): string {
  switch (reason) {
    case "players_away":
    case "absent":
      return "every player has left the table. It resumes when one returns.";
    case "adjudication":
      return "the server is retrying the adjudication.";
    default:
      return reason.replace(/_/g, " ") + ".";
  }
}

/** Ask the table for more time. Granted when enough seats ask (the server counts). */
function Extension({ room, view, me }: { room: Room; view: RoomView; me: PowerName }) {
  const [note, setNote] = useState<string | null>(null);
  const asked = view.extend?.phase === view.phase && view.extend.requestedBy.includes(me);
  const ask = async () => {
    try {
      const ack = await room.extend(view.phase);
      setNote(ack.p.extended ? "Granted: the deadline moved." : `Asked. ${ack.p.requests} so far.`);
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  return (
    <section className="extension">
      <h2>More time</h2>
      {view.extend?.phase === view.phase ? (
        <p className="fine">
          {view.extend.granted ? "The table granted more time this phase." : `${view.extend.requestedBy.map(powerLabel).join(", ")} asked for more time. ${view.extend.needed} must ask.`}
        </p>
      ) : (
        <p className="fine">If enough players ask, the deadline moves by {Math.round(view.settings.extendSeconds / 60)} minutes.</p>
      )}
      <button type="button" className="btn small" onClick={ask} disabled={asked || view.extend?.granted === true}>
        {asked ? "You asked" : "Ask for more time"}
      </button>
      {note ? <p className="fine" role="status">{note}</p> : null}
    </section>
  );
}


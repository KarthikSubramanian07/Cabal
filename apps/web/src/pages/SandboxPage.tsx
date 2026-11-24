import { type CSSProperties, type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePressWords } from "../app/pointer.js";
import { ConfirmDialog } from "../app/ConfirmDialog.jsx";
import { PageLoading } from "../app/PageLoading.jsx";
import { StatusPage } from "../app/StatusPage.jsx";
import { shortcutsEnabled } from "../app/prefs.js";
import { OrderEntry, type WriteResult } from "../components/OrderEntry.jsx";
import { OrderPicker, type PickerState, placePicker } from "../components/OrderPicker.jsx";
import { OrderList, PhaseHeader, PhaseStepper, PowerTable, Results, whyKey } from "../components/Sidebar.jsx";
import { explainPhase, explainerFor } from "../game/explain/explain.js";
import { useWhatIf } from "../game/explain/whatIf.js";
import { trackUnits } from "../game/unitIds.js";
import { deck } from "../sound/deck.js";
import type { PhaseOutcome, State } from "../engine.js";
import {
  type ComposeContext,
  type Draft,
  type Mode,
  type Step,
  canGoByConvoy,
  carryingFleets,
  click,
  disbandSelected,
  holdSelected,
  setMode,
  typedOrder,
  viaAlternative,
} from "../game/compose.js";
import {
  choicePrompt,
  choicesFor,
  describeBoard,
  describeOrder,
  describeOutcome,
  phaseLine,
  statusLine,
} from "../game/describe.js";
import {
  continueLabel,
  describePhase,
  parseOrder,
  parseUnit,
  provinceOf,
  resolveLabel,
  POWER_NAMES,
  titleCase,
} from "../game/notation.js";
import { ImportError } from "../game/persist.js";
import { type Suggestion, normaliseTyped, routeTyped } from "../game/typed.js";
import { type OpenedGame, type PhaseRecord, type Sandbox, powerWithOrders, useSandbox } from "../game/useSandbox.js";
import { Board, type DrawnOrder, type Ghost, POWER_COLOR, type Resolution } from "../map/Board.jsx";
import { resolutionLength } from "../motion/choreography.js";
import { prefersReducedMotion } from "../motion/useReducedMotion.js";
import { type Speed, READ_MS, advance, dwell, playFrom } from "../game/replay.js";

type Picker = PickerState;

const IDLE: Draft = { step: "idle" };

export default function SandboxPage() {
  const load = useSandbox();
  if (load.status === "loading") return <PageLoading />;
  if (load.status === "error") {
    return (
      <StatusPage
        stamp="No board"
        tone="alert"
        title="The board did not load."
        pageTitle="The board did not load"
        actions={
          <>
            <button type="button" className="btn brass" onClick={load.retry}>
              Try again
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </>
        }
      >
        <p>
          The map or the rules engine could not be fetched. Check your connection and try again. A game in progress is
          saved on this device and will be there when the board comes back.
        </p>
        <p className="status-detail">
          <code>{load.error.message}</code>
        </p>
      </StatusPage>
    );
  }
  return <Table sb={load.sandbox} />;
}

function Table({ sb }: { sb: Sandbox }) {
  const [tap, Tap] = usePressWords();
  const [draft, setDraft] = useState<Draft>(IDLE);
  const [active, setActiveState] = useState(sb.resumedActive ?? "FRANCE");
  const [message, setMessage] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  /** The army whose move by convoy was just written: its carrying fleets are offered under the map. */
  const [route, setRoute] = useState<{ power: string; unit: string } | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  /** The phase history is being played back (see game/replay.ts). */
  const [replaying, setReplaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  /** Show a phase (or the live one) because the player asked: any playback stops there. */
  const view = useCallback((index: number | null) => {
    setReplaying(false);
    setViewing(index);
  }, []);
  const [announcement, setAnnouncement] = useState("");
  const [sheet, setSheet] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [importError, setImportError] = useState<{ message: string; detail: string } | null>(null);
  /** A file that has been read and is waiting for the player to agree to replace the game on the board. */
  const [pendingImport, setPendingImport] = useState<{ name: string; game: OpenedGame } | null>(null);
  /** Bumped when the player picks a power by name, so a small board re-frames on it. */
  const [refocus, setRefocus] = useState(0);
  const boardWrap = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const entryRef = useRef<HTMLInputElement>(null);
  const choicesRef = useRef<HTMLElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  /** Set when a keyboard choice (or Escape) removed the focused button, so focus moves on. */
  const moveFocus = useRef(false);
  /** Set by a click or tap on the map, which must not pull focus (and the page) to the choices. */
  const byPointer = useRef(false);

  const setActive = useCallback(
    (power: string) => {
      setActiveState(power);
      sb.noteActive(power);
    },
    [sb],
  );

  const announce = useCallback((text: string) => {
    // Clearing first makes a repeated message announce again.
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(text), 50);
  }, []);



  // An undo, a new game or an import can leave `viewing` pointing past the end of the history.
  useEffect(() => {
    if (viewing !== null && viewing >= sb.history.length) view(null);
  }, [viewing, sb.history.length]);
  const record = viewing !== null ? sb.history[viewing] : undefined;
  /** The live phase is on the board and can take orders. */
  const playing = !record && sb.status === "active";

  /**
   * What if: a sketch of orders for any powers, judged as it is written, that never touches the
   * game. While it is open the composer writes into the sketch instead of the real orders.
   */
  const whatIf = useWhatIf(sb.state, sb.kind);
  const sketching = whatIf.on && playing;
  const book = sketching ? whatIf.orders : sb.orders;
  const writeOrder = sketching ? whatIf.setOrder : sb.setOrder;
  const eraseOrder = sketching ? whatIf.removeOrder : sb.removeOrder;
  /** The sketch played out on the board, by a key that changes with each play. */
  const [sketchPlay, setSketchPlay] = useState<number | null>(null);
  useEffect(() => setSketchPlay(null), [whatIf.orders]);
  // A new phase (or a game loaded) leaves the sketch behind.
  useEffect(() => {
    whatIf.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sb.phase, sb.history.length]);
  /** The receipt whose "why" panel is open. */
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  useEffect(() => setWhyOpen(null), [viewing, whatIf.on]);

  const ctx = useMemo<ComposeContext>(
    () => ({
      phase: sb.kind,
      pieces: sb.pieces,
      legal: sb.legal,
      active,
      allowance: sb.allowance,
      orders: book,
    }),
    [sb.kind, sb.pieces, sb.legal, sb.allowance, book, active],
  );
  const apply = useCallback(
    (step: Step, client?: { x: number; y: number }) => {
      setDraft(step.draft);
      if (step.draft.step !== "idle") setActive(step.draft.power);
      const effect = step.effect;
      if (effect.kind === "order") {
        writeOrder(effect.power, effect.key, effect.text);
        deck.play("quill");
        setActive(effect.power);
        setMessage(null);
        // A move by convoy goes nowhere without fleets: offer the ones that could carry it.
        // Ordering one of those fleets keeps the offer up, so a route of two fleets is two taps.
        if (effect.text.endsWith(" VIA")) setRoute({ power: effect.power, unit: effect.key });
        else if (!/ C A /.test(effect.text)) setRoute(null);
        announce(describeOrder(effect.text));
      } else if (effect.kind === "choose") {
        // Without a pointer (the keyboard choices), open it in the middle of the board. Either way
        // keep it on screen and over the map, so it never hides the order tools under the map.
        const at = placePicker(
          boardWrap.current?.getBoundingClientRect(),
          boardWrap.current?.querySelector(".board-frame")?.getBoundingClientRect(),
          effect.options.length,
          client,
        );
        setPicker({
          ...at,
          title: effect.title,
          power: effect.power,
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
    [writeOrder, announce, setActive],
  );

  const onProvince = useCallback(
    (code: string, client: { x: number; y: number }) => {
      if (!playing) return;
      setPicker(null);
      byPointer.current = true;
      apply(click(ctx, draft, code), client);
    },
    [ctx, draft, apply, playing],
  );

  const mode = useCallback((m: Mode) => apply(setMode(ctx, draft, m)), [ctx, draft, apply]);

  const cancel = useCallback(() => {
    // If the focused control (a picker option, Cancel) is about to vanish, move focus on.
    if (document.activeElement?.closest(".picker, .choices, [data-vanishes]")) moveFocus.current = true;
    setDraft(IDLE);
    setPicker(null);
    setMessage(null);
    setRoute(null);
  }, []);

  /** Play the history back from here, or from the first phase when the live one is shown. */
  const play = useCallback(() => {
    const from = playFrom(viewing, sb.history.length);
    if (from === null) return;
    cancel();
    setViewing(from);
    setReplaying(true);
  }, [viewing, sb.history.length, cancel]);

  const adjudicate = useCallback(() => {
    const given = new Set(Object.values(sb.orders).flatMap((o) => Object.values(o)));
    const outcome = sb.adjudicate();
    cancel();
    if (outcome) {
      view(sb.history.length);
      announce(describeOutcome(outcome, given));
    }
  }, [sb, cancel, announce]);

  const undo = useCallback(() => {
    sb.undo();
    // Back to the live phase: left on a results index, the board would ignore every click.
    view(null);
    cancel();
    announce("Last phase undone.");
  }, [sb, cancel, announce]);

  /** Every legal order on the board, to suggest while an order is typed. */
  const suggestions = useMemo<Suggestion[]>(
    () =>
      Object.entries(sb.legal).flatMap(([power, byUnit]) =>
        Object.values(byUnit).flatMap((orders) => orders.map((text) => ({ power, text }))),
      ),
    [sb.legal],
  );

  /** Write orders typed as text: the engine reads and judges each, the composer keys it like a click. */
  const writeTyped = useCallback(
    (inputs: string[]): WriteResult => {
      const result: WriteResult = { written: [], refused: [] };
      // Later orders in one batch must see the earlier ones, for the winter allowance.
      const orders = Object.fromEntries(Object.entries(book).map(([p, o]) => [p, { ...o }]));
      let last: string | null = null;
      for (const input of inputs) {
        // Arrows and words first, so `A BER->KIE` reads as the player meant it.
        const typed = normaliseTyped(input);
        const { power, verdict } = routeTyped((p) => sb.judge(p, typed), active, POWER_NAMES);
        if (!verdict.legal || !verdict.canonical) {
          result.refused.push({ input, reason: verdict.reason });
          continue;
        }
        const step = typedOrder({ ...ctx, orders }, power, verdict.canonical);
        if (step.effect.kind !== "order") {
          result.refused.push({ input, reason: step.effect.kind === "message" ? step.effect.text : verdict.reason });
          continue;
        }
        const { key, text } = step.effect;
        writeOrder(power, key, text);
        orders[power] = { ...orders[power], [key]: text };
        result.written.push(text);
        last = power;
      }
      if (last) {
        deck.play("quill");
        setActive(last);
        setRoute(null);
        setDraft(IDLE);
      }
      return result;
    },
    [sb, ctx, active, setActive, book, writeOrder],
  );

  const startNew = useCallback(() => {
    sb.reset();
    view(null);
    setConfirmNew(false);
    setImportError(null);
    setActive("FRANCE");
    cancel();
    announce("New game started: Spring 1901 movement.");
  }, [sb, cancel, announce, setActive]);

  const touched = sb.history.length > 0 || Object.values(sb.orders).some((o) => Object.keys(o).length > 0);

  // A new phase can leave the open power with nothing to do: only Austria retreats, only
  // England builds. Open the first power that has something to order, so the choices under
  // the map and the sheet's note are never empty while orders are owed elsewhere.
  useEffect(() => {
    if (sb.status !== "active") return;
    const next = powerWithOrders(sb.powers, active);
    if (next === active) return;
    setActive(next);
    setRefocus((n) => n + 1);
    // Only when the phase changes (or a game is loaded), never while orders are being written.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sb.phase, sb.history.length, sb.status]);

  // Say where the player is when they step through the phase history or back to the live phase.
  const lastViewing = useRef<number | null>(null);
  useEffect(() => {
    const was = lastViewing.current;
    lastViewing.current = viewing;
    if (was === viewing) return;
    // Adjudicating or leaving the results swaps the sidebar and removes the focused button.
    // Land on the button in the same place (Adjudicate, Next phase, Continue) so Enter keeps going.
    if (!document.activeElement || document.activeElement === document.body) {
      document.querySelector<HTMLButtonElement>(".sidebar .actions .btn.primary")?.focus();
    }
    if (viewing === null) {
      announce(statusLine(sb.status) ?? `Now ${phaseLine(sb.phase)}. Give orders for each power.`);
    } else if (was !== null) {
      const shown = sb.history[viewing];
      if (shown) announce(`Showing the ${phaseLine(shown.phase)} results.`);
    }
  }, [viewing, sb, announce]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, select, textarea, dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      // Enter and Space belong to whatever button or link has focus.
      const onControl = Boolean(el.closest("button, a, [role='button']"));
      if (key === "escape") return cancel();
      // Space plays and pauses the history, unless it belongs to a focused control.
      if (key === " " && !onControl && sb.history.length > 0 && shortcutsEnabled()) {
        e.preventDefault();
        return replaying ? setReplaying(false) : play();
      }
      if (viewing !== null) {
        if ((key === "enter" && !onControl) || key === "arrowright") {
          e.preventDefault();
          view(viewing + 1 >= sb.history.length ? null : viewing + 1);
        } else if (key === "arrowleft" && viewing > 0) {
          view(viewing - 1);
        }
        return;
      }
      // Stepping back into the history must not swallow an order half written, and belongs to
      // the board: with focus on a button or a link the arrow keys are not ours to take.
      if (key === "arrowleft" && !onControl && sb.history.length > 0 && draft.step === "idle" && !picker) {
        return view(sb.history.length - 1);
      }
      // Single-key shortcuts can be switched off (WCAG 2.1.4) in How to play.
      if (!shortcutsEnabled()) return;
      if (key === "s") return mode("support");
      if (key === "c") return mode("convoy");
      if (key === "v") return mode("via-convoy");
      // The order field, for writing orders as text (only where it is on screen).
      if (key === "/" && entryRef.current?.checkVisibility?.()) {
        e.preventDefault();
        return entryRef.current.focus();
      }
      if (key === "m") return mode("move");
      if (key === "h") return apply(holdSelected(ctx, draft));
      if (key === "d") return apply(disbandSelected(ctx, draft));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx, draft, picker, mode, apply, cancel, viewing, sb, view, replaying, play]);

  // Keyboard path: after a choice, a shortcut or a cancel, focus the first new choice (or the
  // coast picker) instead of leaving focus on a button that no longer exists.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (picker) {
      pickerRef.current?.querySelector("button")?.focus();
      return;
    }
    // An order given on the map leaves focus where it was: moving it to the choices under the
    // map would scroll the page and slide the board out from under the finger.
    const pointed = byPointer.current;
    byPointer.current = false;
    const lost = !pointed && (!document.activeElement || document.activeElement === document.body);
    if (!moveFocus.current && !lost) return;
    moveFocus.current = false;
    const panel = choicesRef.current;
    const first = panel?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (first ?? panel)?.focus();
    // Focus alone can leave the button flush with the edge of the window, its outline cut off.
    first?.scrollIntoView({ block: "nearest" });
  }, [draft, picker, viewing]);

  // provinces the current draft can act on
  const targets = useMemo(() => {
    const set = new Set<string>();
    if (draft.step === "idle") return set;
    const legal = sb.legal[draft.power]?.[draft.unit] ?? [];
    for (const text of legal) {
      const o = parseOrder(text);
      if (!o) continue;
      // With By convoy chosen, only where a fleet could land the army.
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
  }, [sb.legal, draft]);

  /** Provinces where a tap starts something: a unit that can be ordered, or a build or disband. */
  const hot = useMemo(() => {
    const set = new Set<string>();
    for (const byUnit of Object.values(sb.legal)) {
      for (const [unit, options] of Object.entries(byUnit)) {
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
    }
    return set;
  }, [sb.legal]);

  /** What a small board frames by default: where the active power stands and what it owns. */
  const focus = useMemo(() => {
    const codes = new Set<string>(sb.state.centers[active] ?? []);
    for (const u of sb.state.units[active] ?? []) {
      const ref = parseUnit(u);
      if (ref) codes.add(ref.province);
    }
    return [...codes];
  }, [sb.state, active]);

  const mapState = record ? record.state : sb.state;
  const given = record ? new Set(Object.values(record.orders).flatMap((o) => Object.values(o))) : null;
  const drawn: DrawnOrder[] = record
    ? record.outcome.results
        .filter((r) => given!.has(r.order) || (!r.ok && parseOrder(r.order)?.type !== "hold"))
        .map((r) => ({ power: r.power, text: r.order, ok: r.ok }))
    : Object.entries(book).flatMap(([power, entries]) =>
        Object.values(entries).map((text): DrawnOrder => {
          // A sketch is judged as it is written: each order carries its predicted result.
          const predicted = sketching ? whatIf.prediction?.outcome.results.find((r) => r.power === power && r.order === text) : undefined;
          return predicted ? { power, text, ok: predicted.ok } : { power, text };
        }),
      );
  const prediction = sketching ? whatIf.prediction : null;
  /** Where the sketch would leave the units that move: dashed pieces on the board. */
  const ghosts = useMemo<Ghost[]>(() => {
    if (!prediction) return [];
    const list: Ghost[] = [];
    for (const r of prediction.outcome.results) {
      const o = parseOrder(r.order);
      if (r.ok && (o?.type === "move" || o?.type === "retreat")) list.push({ power: r.power, kind: o.unit.kind, region: o.dest });
    }
    return list;
  }, [prediction]);

  /** The phase on show, to be played on the board: its pieces march from where they stood. */
  const resolution = useMemo<Resolution | undefined>(
    () =>
      sketchPlay !== null && prediction
        ? playedSketch(sketchPlay, sb.history, sb.state, prediction.outcome)
        : record && viewing !== null
        ? {
            key: `${viewing}-${record.phase}`,
            phase: record.phase,
            before: record.state,
            after: record.outcome.next,
            results: record.outcome.results,
            beforeIds: sb.units.phases[viewing],
            afterIds: sb.units.phases[viewing + 1] ?? sb.units.live,
          }
        : undefined,
    [record, viewing, sb.units, sketchPlay, prediction, sb.state],
  );
  /** The phase whose choreography has finished (or was skipped). */
  const [settled, setSettled] = useState<string | null>(null);

  // Playback: each phase plays out on the board, then stays up long enough to read.
  useEffect(() => {
    if (!replaying) return;
    if (viewing === null || !resolution) {
      setReplaying(false);
      return;
    }
    const next = () => setViewing(advance(viewing, sb.history.length));
    if (settled === resolution.key) {
      const timer = window.setTimeout(next, Math.round(READ_MS / speed));
      return () => window.clearTimeout(timer);
    }
    // Should the board never report back (drawn off screen), move on after the time it would take.
    const reduced = prefersReducedMotion();
    const timer = window.setTimeout(next, dwell(resolutionLength(resolution, drawn, reduced), speed, reduced) + 1500);
    return () => window.clearTimeout(timer);
    // `drawn` follows `resolution`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaying, viewing, speed, settled, resolution, sb.history.length]);

  // Why an order failed: the engine's account of the phase on show (or of the sketch).
  const explanation = useMemo(() => (record ? explainPhase(record) : null), [record]);
  const names = sb.board.provinces;
  const explainShown = useMemo(
    () => (record ? explainerFor(record.outcome.results, record.phase, explanation, names) : null),
    [record, explanation, names],
  );
  const explainSketch = useMemo(
    () => (prediction ? explainerFor(prediction.outcome.results, sb.phase, prediction.explanation, names) : null),
    [prediction, sb.phase, names],
  );
  /** The panel open now, so the board can pick out the units behind it. */
  const openWhy = useMemo(() => {
    if (!whyOpen) return null;
    const results = record ? record.outcome.results : prediction?.outcome.results;
    const r = results?.find((x, i) => whyKey(x, i) === whyOpen);
    const fn = record ? explainShown : explainSketch;
    return r && fn ? fn(r) : null;
  }, [whyOpen, record, prediction, explainShown, explainSketch]);

  /** Open a sketch from the orders written so far; close it; or make it the real orders. */
  const toggleWhatIf = () => {
    if (whatIf.on) {
      whatIf.stop();
      announce("What if closed. The orders you had written are as they were.");
    } else {
      cancel();
      whatIf.start(sb.orders);
      announce("What if: sketch orders for any power and see how the phase would resolve. Nothing is sent and the game does not change.");
    }
  };
  const keepSketch = () => {
    sb.clearOrders();
    for (const [power, entries] of Object.entries(whatIf.orders)) {
      for (const [key, text] of Object.entries(entries)) sb.setOrder(power, key, text);
    }
    whatIf.stop();
    announce("The sketched orders are now your orders.");
  };

  /** The power table counts the orders on the table: the sketch's while one is open. */
  const tablePowers = useMemo(
    () => (sketching ? sb.powers.map((p) => ({ ...p, given: Object.keys(whatIf.orders[p.power] ?? {}).length })) : sb.powers),
    [sketching, sb.powers, whatIf.orders],
  );
  const selectedProvince = draft.step === "idle" ? null : parseUnit(draft.unit)?.province ?? null;
  const activeSummary = sb.powers.find((p) => p.power === active);
  const orderableUnits = Object.keys(sb.legal[active] ?? {}).filter((u) => u !== "");
  /** The selected army could be carried by sea, so By convoy is on offer. */
  const convoyable = playing && draft.step === "unit" && canGoByConvoy(ctx, draft.power, draft.unit);
  /** The move by convoy whose fleets are on offer, while it is still written that way. */
  const routeOrder = playing && route && draft.step === "idle" ? book[route.power]?.[route.unit] : undefined;
  const carriers = routeOrder?.endsWith(" VIA") ? carryingFleets(ctx, routeOrder) : [];
  const choices = playing ? choicesFor(ctx, draft, active, orderableUnits, targets, sb.board.provinces) : [];
  const choose = (code: string) => {
    if (!playing) return;
    setPicker(null);
    moveFocus.current = true;
    apply(click(ctx, draft, code));
  };
  const boardText = describeBoard(mapState, sb.board.provinces);

  const hint: ReactNode = (() => {
    if (record) {
      return (
        <>
          Showing how the phase resolved.<span className="keys-only"> Use the arrow keys or Enter to step forward.</span>
        </>
      );
    }
    if (sb.status !== "active") return "The game is over. Undo a phase or start a new game.";
    if (message) return message;
    if (picker) return `${picker.title}: choose from the menu.`;
    switch (draft.step) {
      case "idle":
        return sb.kind === "A"
          ? `${Tap} an empty home supply centre to build, or a unit to disband.`
          : sb.kind === "R"
            ? `${Tap} a dislodged unit, then where it retreats.`
            : `${Tap} a unit, then where it should go.`;
      case "unit":
        if (draft.via) {
          return `${draft.unit} by convoy: ${tap} where the fleets should land it.`;
        }
        return sb.kind === "R" ? (
          <>
            {draft.unit}: {tap} an empty neighbour, or disband it<span className="keys-only"> (D)</span>.
          </>
        ) : (
          <>
            {draft.unit}: {tap} a destination, or {tap} it again to hold
            <span className="keys-only">
              . Press S to support, C to convoy{canGoByConvoy(ctx, draft.power, draft.unit) ? ", V to go by convoy" : ""}
            </span>
            .
          </>
        );
      case "support":
        return draft.target
          ? `${draft.unit} supports ${draft.target}: ${tap} where it is going, or ${draft.target} again to support it holding.`
          : `${draft.unit} supports: ${tap} the unit to support.`;
      case "convoy":
        return draft.army
          ? `${draft.unit} convoys ${draft.army}: ${tap} where it lands.`
          : `${draft.unit} convoys: ${tap} the army.`;
    }
  })();

  const download = () => {
    const blob = new Blob([sb.exportSaved()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cabal-${sb.phase.toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadImport = (pending: { name: string; game: OpenedGame }) => {
    pending.game.load();
    setPendingImport(null);
    view(null);
    cancel();
    announce(`Game loaded from ${pending.name}: ${phaseLine(pending.game.phase)}.`);
  };

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const game = sb.openSaved(await file.text());
      setImportError(null);
      // The file is good. A game in progress is only replaced once the player says so.
      if (touched) setPendingImport({ name: file.name, game });
      else loadImport({ name: file.name, game });
    } catch (err) {
      // Never the parser's own words in the player's face: a sentence, with the detail tucked away.
      const shown =
        err instanceof ImportError
          ? { message: err.message, detail: err.detail }
          : { message: "That file could not be loaded.", detail: err instanceof Error ? err.message : String(err) };
      setImportError(shown);
      announce(shown.message);
    }
  };

  // The line on the phone sheet's handle: where the game is and what is left to do.
  const shown = describePhase(record ? record.phase : sb.phase);
  const sheetTitle = record ? `${shown.season} ${shown.year} results` : `${shown.season} ${shown.year}`;
  const sheetNote = (() => {
    if (record) {
      const failed = record.outcome.results.filter((r) => !r.ok && r.code !== "disband").length;
      return failed ? `${failed} ${failed === 1 ? "order" : "orders"} failed` : "Every order succeeded";
    }
    if (sketching) {
      const n = Object.values(whatIf.orders).reduce((sum, o) => sum + Object.keys(o).length, 0);
      return `What if: ${n} ${n === 1 ? "order" : "orders"} sketched`;
    }
    if (sb.status !== "active") return statusLine(sb.status) ?? "Game over";
    if (!activeSummary || activeSummary.due === 0) return `${titleCase(active)}: nothing to order`;
    return `${titleCase(active)}: ${Math.min(activeSummary.given, activeSummary.due)} of ${activeSummary.due} ${
      sb.kind === "A" ? (activeSummary.allowance > 0 ? "builds" : "disbands") : "orders"
    }`;
  })();

  const last = viewing !== null && viewing + 1 >= sb.history.length;

  return (
    <>
      <main className="table" id="main" tabIndex={-1}>
        <h1 className="sr-only">Cabal Diplomacy sandbox</h1>
        <div className="board-wrap" ref={boardWrap}>
          {/* The stage is the map and its order tools: on a phone, exactly the first screen. */}
          <div className="stage">
          <Board
            board={sb.board}
            state={mapState}
            orders={drawn}
            selected={record ? null : selectedProvince}
            targets={record ? undefined : targets}
            hot={playing ? hot : undefined}
            standoffs={record?.outcome.standoffs ?? prediction?.outcome.standoffs}
            sketch={sketching}
            ghosts={sketching && sketchPlay === null ? ghosts : undefined}
            highlight={openWhy?.highlight}
            resolution={resolution}
            rate={replaying ? speed : 1}
            onSettled={setSettled}
            ids={record ? sb.units.phases[viewing!] : sb.units.live}
            focus={focus}
            focusKey={refocus}
            onProvince={onProvince}
          />
          {sb.resumed ? (
            <div className="resume" role="status">
              <p>
                <strong>Saved game restored.</strong> You are back in {phaseLine(sb.resumed)}.
              </p>
              <button type="button" className="btn small" onClick={() => setConfirmNew(true)}>
                New game
              </button>
              <button type="button" className="btn small" onClick={sb.dismissResumed}>
                Dismiss
              </button>
            </div>
          ) : null}
          {picker ? (
            <OrderPicker
              picker={picker}
              menuRef={pickerRef}
              onChoose={(o) => {
                writeOrder(picker.power, picker.key, o);
                deck.play("quill");
                setActive(picker.power);
                setPicker(null);
                if (o.endsWith(" VIA")) setRoute({ power: picker.power, unit: picker.key });
                moveFocus.current = true;
                announce(describeOrder(o));
              }}
            />
          ) : null}

          <div className="toolbar" role="group" aria-label="Order tools">
            {sb.kind === "M" && playing ? (
              <>
                <button type="button" className="tool" aria-pressed={draft.step === "unit"} onClick={() => mode("move")}>
                  Move <kbd>M</kbd>
                </button>
                <button
                  type="button"
                  className="tool"
                  aria-pressed={draft.step === "support"}
                  onClick={() => mode("support")}
                >
                  Support <kbd>S</kbd>
                </button>
                <button
                  type="button"
                  className="tool"
                  aria-pressed={draft.step === "convoy"}
                  onClick={() => mode("convoy")}
                >
                  Convoy <kbd>C</kbd>
                </button>
                {convoyable ? (
                  <button
                    type="button"
                    className="tool"
                    aria-pressed={draft.step === "unit" && Boolean(draft.via)}
                    onClick={() => mode("via-convoy")}
                  >
                    By convoy <kbd>V</kbd>
                  </button>
                ) : null}
                <button type="button" className="tool" onClick={() => apply(holdSelected(ctx, draft))}>
                  Hold <kbd>H</kbd>
                </button>
              </>
            ) : null}
            {sb.kind === "R" && playing ? (
              <button type="button" className="tool" onClick={() => apply(disbandSelected(ctx, draft))}>
                Disband <kbd>D</kbd>
              </button>
            ) : null}
            {/* Offered between orders, not while one is half written: the toolbar keeps one row
                on a phone, so the map does not resize under the finger mid-order. */}
            {playing && draft.step === "idle" && !picker ? (
              <button type="button" className="tool what-if" aria-pressed={whatIf.on} onClick={toggleWhatIf}>
                What if
              </button>
            ) : null}
            {draft.step !== "idle" || picker ? (
              <button type="button" className="tool" onClick={cancel} data-vanishes>
                Cancel <kbd>Esc</kbd>
              </button>
            ) : null}
            <p className={`hint${message && playing ? " alert" : ""}`} role="status" aria-live="polite">
              {hint}
            </p>
          </div>
          {carriers.length > 0 && routeOrder ? (
            <div className="route" role="group" aria-labelledby="route-title">
              <p className="route-title" id="route-title">
                <span className="route-stamp">Route</span> <code>{routeOrder}</code>{" "}
                {carriers.some((c) => c.given) ? "carried by" : "needs a fleet:"}
              </p>
              <div className="route-fleets">
                {carriers.map((c) => (
                  <button
                    key={c.unit}
                    type="button"
                    className="tool"
                    aria-pressed={c.given}
                    aria-label={c.given ? `${c.unit} carries it; remove the convoy order` : `Order ${c.order}`}
                    onClick={() => {
                      if (c.given) eraseOrder(c.power, c.unit);
                      else writeOrder(c.power, c.unit, c.order);
                      announce(c.given ? `${c.unit} no longer convoys.` : describeOrder(c.order));
                    }}
                  >
                    <span className="swatch" style={{ "--power": POWER_COLOR[c.power] } as CSSProperties} aria-hidden />
                    {c.unit}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          </div>

          {choices.length ? (
            <section className="choices" ref={choicesRef} tabIndex={-1} aria-labelledby="choices-title">
              <h2 id="choices-title">{choicePrompt(sb.kind, draft, draft.step === "idle" ? active : draft.power)}</h2>
              <div className="choice-list">
                {choices.map((c) => (
                  <button key={c.code} type="button" className="tool choice" onClick={() => choose(c.code)}>
                    {c.label}
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <section className="choices" ref={choicesRef} tabIndex={-1} aria-label="Choices" hidden />
          )}

          <details className="board-text">
            <summary>Board as text</summary>
            {boardText.map((p) => (
              <section key={p.power}>
                <h3>{p.power}</h3>
                <p>Units: {p.units.length ? p.units.join("; ") : "none"}.</p>
                <p>
                  Supply centres ({p.centers.length}): {p.centers.length ? p.centers.join(", ") : "none"}.
                </p>
              </section>
            ))}
          </details>
        </div>

        <aside className="sidebar" data-open={sheet} aria-label="Orders and results">
          {/* On a phone the sidebar is a sheet docked to the bottom; this is its handle. */}
          <button
            type="button"
            className="sheet-bar"
            aria-expanded={sheet}
            aria-controls="sheet-body"
            onClick={() => setSheet((open) => !open)}
          >
            <span className="sheet-title">{sheetTitle}</span>
            <span className="sheet-note">{sheetNote}</span>
            <span className="sheet-chevron" aria-hidden="true">
              {sheet ? "Close" : "Orders"}
            </span>
          </button>

          <div className="sheet-body" id="sheet-body">
            <PhaseHeader phase={record ? record.phase : sb.phase} status={sb.status} viewing={Boolean(record)} />
            <PhaseStepper history={sb.history} viewing={viewing} livePhase={sb.phase} onView={view}
              playing={replaying}
              speed={speed}
              onPlay={play}
              onPause={() => setReplaying(false)}
              onSpeed={setSpeed}
            />

            {record ? (
              <Results
                record={record}
                names={sb.board.provinces}
                explain={explainShown ?? undefined}
                open={whyOpen}
                onOpen={setWhyOpen}
              />
            ) : (
              <>
                {sketching ? (
                  <section className="what-if-panel" aria-labelledby="what-if-title">
                    <h2 id="what-if-title">
                      <span className="what-if-stamp">What if</span>
                    </h2>
                    <p className="hint">
                      Sketch orders for any power, on the map or below. The prediction is the engine&apos;s own; nothing is sent
                      and the game does not change.
                    </p>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn small"
                        disabled={!prediction}
                        onClick={() => setSketchPlay((n) => (n ?? 0) + 1)}
                      >
                        Play it out
                      </button>
                      <button type="button" className="btn small" onClick={keepSketch}>
                        Use these orders
                      </button>
                      <button type="button" className="btn small" onClick={toggleWhatIf}>
                        Discard
                      </button>
                    </div>
                    {prediction ? (
                      <Results
                        record={{ phase: sb.phase, orders: whatIf.orders, outcome: prediction.outcome }}
                        names={sb.board.provinces}
                        explain={explainSketch ?? undefined}
                        open={whyOpen}
                        onOpen={setWhyOpen}
                        label="Predicted results"
                      />
                    ) : (
                      <p className="hint">These orders cannot be judged together yet.</p>
                    )}
                  </section>
                ) : null}
                <section>
                  <PowerTable
                    powers={tablePowers}
                    active={active}
                    kind={sb.kind}
                    onSelect={(power) => {
                      setActive(power);
                      setRefocus((n) => n + 1);
                    }}
                  />
                </section>
                <section>
                  <h2>{titleCase(active)}</h2>
                  <OrderList
                    power={active}
                    kind={sb.kind}
                    units={orderableUnits}
                    orders={book[active] ?? {}}
                    allowance={activeSummary?.allowance ?? 0}
                    onRemove={(key) => eraseOrder(active, key)}
                    alternative={(text) => viaAlternative(ctx, active, text)}
                    onReplace={(key, text) => {
                      writeOrder(active, key, text);
                      setRoute(text.endsWith(" VIA") ? { power: active, unit: key } : null);
                      announce(describeOrder(text));
                    }}
                  />
                  <div className="row-actions">
                    {sb.kind === "M" ? (
                      <button type="button" className="btn small" onClick={() => (sketching ? whatIf.holdAll(active, orderableUnits) : sb.holdAll(active))}>
                        Hold the rest
                      </button>
                    ) : null}
                    {sb.kind === "A" && (activeSummary?.allowance ?? 0) > 0 ? (
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => sb.waive(active)}
                        disabled={sketching ||(activeSummary?.given ?? 0) >= (activeSummary?.allowance ?? 0)}
                      >
                        Waive a build
                      </button>
                    ) : null}
                    <button type="button" className="btn small" onClick={() => (sketching ? whatIf.clearOrders(active) : sb.clearOrders(active))}>
                      Clear
                    </button>
                  </div>
                  <OrderEntry ref={entryRef} legal={suggestions} active={active} onWrite={writeTyped} />
                </section>
              </>
            )}
          </div>

          <div className="actions">
            {record ? (
              <button type="button" className="btn primary" onClick={() => view(last ? null : viewing! + 1)}>
                {last ? continueLabel(sb.phase) : "Next phase"}
              </button>
            ) : (
              sketching ? (
                <button type="button" className="btn primary" onClick={toggleWhatIf}>
                  Leave what if
                </button>
              ) : (
                <button type="button" className="btn primary" onClick={adjudicate} disabled={sb.status !== "active"}>
                  {resolveLabel(sb.phase)}
                </button>
              )
            )}
          </div>

          <section className="game-tools" aria-label="Game">
            <button type="button" className="btn small" onClick={undo} disabled={sb.history.length === 0}>
              Undo last phase
            </button>
            <button type="button" className="btn small" onClick={() => (touched ? setConfirmNew(true) : startNew())}>
              New game
            </button>
            <button type="button" className="btn small" onClick={download}>
              Export
            </button>
            <button type="button" className="btn small" onClick={() => fileInput.current?.click()}>
              Import
            </button>
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={upload} />
            {importError ? (
              <div className="import-error" role="alert">
                <p>{importError.message}</p>
                <details>
                  <summary>Technical detail</summary>
                  <code>{importError.detail}</code>
                </details>
              </div>
            ) : null}
          </section>
        </aside>
      </main>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <ConfirmDialog
        open={confirmNew}
        title="Start a new game?"
        confirmLabel="Start a new game"
        cancelLabel="Keep playing"
        onConfirm={startNew}
        onCancel={() => setConfirmNew(false)}
      >
        <p>
          This board{sb.history.length ? ` and its ${sb.history.length} resolved ${sb.history.length === 1 ? "phase" : "phases"}` : ""} will
          be cleared from this device. Export it first if you want to keep it.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingImport !== null}
        title="Replace this game?"
        confirmLabel="Load the file"
        cancelLabel="Keep playing"
        onConfirm={() => pendingImport && loadImport(pendingImport)}
        onCancel={() => setPendingImport(null)}
      >
        <p>
          Loading <code>{pendingImport?.name}</code> replaces the board
          {sb.history.length ? ` and its ${sb.history.length} resolved ${sb.history.length === 1 ? "phase" : "phases"}` : ""} on
          this device. Export the game you have first if you want to keep it.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** A sketch played out: the live position, and where the predicted outcome leaves it. */
function playedSketch(n: number, history: readonly PhaseRecord[], state: State, outcome: PhaseOutcome): Resolution {
  const after = outcome.next;
  // The same ids the board already uses for the live position, carried one phase on.
  const ids = trackUnits([...history, { state, outcome }], after);
  return {
    key: `what-if-${n}`,
    phase: state.name,
    before: state,
    after,
    results: outcome.results,
    beforeIds: ids.phases[history.length],
    afterIds: ids.live,
  };
}

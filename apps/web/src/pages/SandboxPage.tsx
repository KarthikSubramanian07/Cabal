import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../app/ConfirmDialog.jsx";
import { PageLoading } from "../app/PageLoading.jsx";
import { StatusPage } from "../app/StatusPage.jsx";
import { useShortcuts } from "../app/prefs.js";
import { OrderList, PhaseHeader, PhaseStepper, PowerTable, Results } from "../components/Sidebar.jsx";
import {
  type ComposeContext,
  type Draft,
  type Mode,
  type Step,
  click,
  disbandSelected,
  holdSelected,
  setMode,
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
  titleCase,
} from "../game/notation.js";
import { ImportError } from "../game/persist.js";
import { type Sandbox, useSandbox } from "../game/useSandbox.js";
import { Board, type DrawnOrder } from "../map/Board.jsx";

interface Picker {
  x: number;
  y: number;
  title: string;
  power: string;
  key: string;
  options: string[];
  /** When it opened (event clock), to ignore the click a touch sends after the tap that opened it. */
  openedAt: number;
}

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
  const [draft, setDraft] = useState<Draft>(IDLE);
  const [active, setActiveState] = useState(sb.resumedActive ?? "FRANCE");
  const [message, setMessage] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [sheet, setSheet] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [importError, setImportError] = useState<{ message: string; detail: string } | null>(null);
  /** Bumped when the player picks a power by name, so a small board re-frames on it. */
  const [refocus, setRefocus] = useState(0);
  const [shortcuts] = useShortcuts();
  const boardWrap = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const choicesRef = useRef<HTMLElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  /** Set when a keyboard choice (or Escape) removed the focused button, so focus moves on. */
  const moveFocus = useRef(false);

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

  const ctx = useMemo<ComposeContext>(
    () => ({
      phase: sb.kind,
      pieces: sb.pieces,
      legal: sb.legal,
      active,
      allowance: sb.allowance,
      orders: sb.orders,
    }),
    [sb.kind, sb.pieces, sb.legal, sb.allowance, sb.orders, active],
  );

  // An undo, a new game or an import can leave `viewing` pointing past the end of the history.
  useEffect(() => {
    if (viewing !== null && viewing >= sb.history.length) setViewing(null);
  }, [viewing, sb.history.length]);
  const record = viewing !== null ? sb.history[viewing] : undefined;
  /** The live phase is on the board and can take orders. */
  const playing = !record && sb.status === "active";

  const apply = useCallback(
    (step: Step, client?: { x: number; y: number }) => {
      setDraft(step.draft);
      if (step.draft.step !== "idle") setActive(step.draft.power);
      const effect = step.effect;
      if (effect.kind === "order") {
        sb.setOrder(effect.power, effect.key, effect.text);
        setActive(effect.power);
        setMessage(null);
        announce(describeOrder(effect.text));
      } else if (effect.kind === "choose") {
        const rect = boardWrap.current?.getBoundingClientRect();
        const frame = boardWrap.current?.querySelector(".board-frame")?.getBoundingClientRect();
        // Without a pointer (the keyboard choices), open it in the middle of the board. Either way
        // keep it on screen and over the map, so it never hides the order tools under the map.
        const half = 100;
        const tall = 34 + effect.options.length * 44;
        const x = client && rect ? client.x - rect.left : rect ? rect.width / 2 : 40;
        const y = client && rect ? client.y - rect.top : rect ? rect.height / 3 : 40;
        const maxY = frame && rect ? frame.bottom - rect.top - tall - 12 : y;
        setPicker({
          x: rect ? Math.min(Math.max(x, half), rect.width - half) : x,
          y: Math.max(0, Math.min(y, maxY)),
          title: effect.title,
          power: effect.power,
          key: effect.key,
          options: effect.options,
          openedAt: performance.now(),
        });
        setMessage(null);
      } else if (effect.kind === "message") {
        setMessage(effect.text);
        announce(effect.text);
      } else if (step.draft.step !== "idle") {
        setMessage(null);
      }
    },
    [sb, announce, setActive],
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
    // If the focused control (a picker option, Cancel) is about to vanish, move focus on.
    if (document.activeElement?.closest(".picker, .choices, [data-vanishes]")) moveFocus.current = true;
    setDraft(IDLE);
    setPicker(null);
    setMessage(null);
  }, []);

  const adjudicate = useCallback(() => {
    const given = new Set(Object.values(sb.orders).flatMap((o) => Object.values(o)));
    const outcome = sb.adjudicate();
    cancel();
    if (outcome) {
      setViewing(sb.history.length);
      announce(describeOutcome(outcome, given));
    }
  }, [sb, cancel, announce]);

  const undo = useCallback(() => {
    sb.undo();
    // Back to the live phase: left on a results index, the board would ignore every click.
    setViewing(null);
    cancel();
    announce("Last phase undone.");
  }, [sb, cancel, announce]);

  const startNew = useCallback(() => {
    sb.reset();
    setViewing(null);
    setConfirmNew(false);
    setImportError(null);
    setActive("FRANCE");
    cancel();
    announce("New game started: Spring 1901 movement.");
  }, [sb, cancel, announce, setActive]);

  const touched = sb.history.length > 0 || Object.values(sb.orders).some((o) => Object.keys(o).length > 0);

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
      if (viewing !== null) {
        if ((key === "enter" && !onControl) || key === "arrowright") {
          e.preventDefault();
          setViewing(viewing + 1 >= sb.history.length ? null : viewing + 1);
        } else if (key === "arrowleft" && viewing > 0) {
          setViewing(viewing - 1);
        }
        return;
      }
      // Stepping back into the history must not swallow an order half written.
      if (key === "arrowleft" && sb.history.length > 0 && draft.step === "idle" && !picker) {
        return setViewing(sb.history.length - 1);
      }
      // Single-key shortcuts can be switched off (WCAG 2.1.4) in How to play.
      if (!shortcuts) return;
      if (key === "s") return mode("support");
      if (key === "c") return mode("convoy");
      if (key === "m") return mode("move");
      if (key === "h") return apply(holdSelected(ctx, draft));
      if (key === "d") return apply(disbandSelected(ctx, draft));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx, draft, picker, mode, apply, cancel, viewing, sb, shortcuts]);

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
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!moveFocus.current && !lost) return;
    moveFocus.current = false;
    const panel = choicesRef.current;
    const first = panel?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (first ?? panel)?.focus();
  }, [draft, picker, viewing]);

  // provinces the current draft can act on
  const targets = useMemo(() => {
    const set = new Set<string>();
    if (draft.step === "idle") return set;
    const legal = sb.legal[draft.power]?.[draft.unit] ?? [];
    for (const text of legal) {
      const o = parseOrder(text);
      if (!o) continue;
      if (draft.step === "unit" && (o.type === "move" || o.type === "retreat")) set.add(provinceOf(o.dest));
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
    : Object.entries(sb.orders).flatMap(([power, entries]) => Object.values(entries).map((text) => ({ power, text })));

  const selectedProvince = draft.step === "idle" ? null : parseUnit(draft.unit)?.province ?? null;
  const activeSummary = sb.powers.find((p) => p.power === active);
  const orderableUnits = Object.keys(sb.legal[active] ?? {}).filter((u) => u !== "");
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
          ? "Click an empty home supply centre to build, or a unit to disband."
          : sb.kind === "R"
            ? "Click a dislodged unit, then where it retreats."
            : "Click a unit, then where it should go.";
      case "unit":
        return sb.kind === "R" ? (
          <>
            {draft.unit}: click an empty neighbour, or disband it<span className="keys-only"> (D)</span>.
          </>
        ) : (
          <>
            {draft.unit}: click a destination, or click it again to hold
            <span className="keys-only">. Press S to support, C to convoy</span>.
          </>
        );
      case "support":
        return draft.target
          ? `${draft.unit} supports ${draft.target}: click where it is going, or ${draft.target} again to support it holding.`
          : `${draft.unit} supports: click the unit to support.`;
      case "convoy":
        return draft.army
          ? `${draft.unit} convoys ${draft.army}: click where it lands.`
          : `${draft.unit} convoys: click the army.`;
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

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      sb.importSaved(await file.text());
      setViewing(null);
      setImportError(null);
      cancel();
      announce(`Game loaded from ${file.name}.`);
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
            standoffs={record?.outcome.standoffs}
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
            <div
              className="picker"
              ref={pickerRef}
              style={{ left: picker.x, top: picker.y }}
              role="menu"
              aria-labelledby="picker-title"
              onKeyDown={(e) => {
                // Menu keys: arrows and Home/End move between options; Escape cancels (window handler).
                const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
                const at = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  e.key === "ArrowDown"
                    ? (at + 1) % items.length
                    : e.key === "ArrowUp"
                      ? (at - 1 + items.length) % items.length
                      : e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? items.length - 1
                          : -1;
                if (next < 0) return;
                e.preventDefault();
                e.stopPropagation();
                items[next]?.focus();
              }}
            >
              <div className="picker-title" id="picker-title" role="presentation">
                {picker.title}
              </div>
              {picker.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    // A touch is followed by a synthetic click at the same spot. If the menu opened
                    // under the finger, that click must not choose for the player.
                    if (e.timeStamp - picker.openedAt < 350) return;
                    sb.setOrder(picker.power, picker.key, o);
                    setActive(picker.power);
                    setPicker(null);
                    moveFocus.current = true;
                    announce(describeOrder(o));
                  }}
                >
                  {o}
                </button>
              ))}
            </div>
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
            {draft.step !== "idle" || picker ? (
              <button type="button" className="tool" onClick={cancel} data-vanishes>
                Cancel <kbd>Esc</kbd>
              </button>
            ) : null}
            <p className={`hint${message && playing ? " alert" : ""}`} role="status" aria-live="polite">
              {hint}
            </p>
          </div>
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
            <PhaseStepper history={sb.history} viewing={viewing} livePhase={sb.phase} onView={setViewing} />

            {record ? (
              <Results record={record} names={sb.board.provinces} />
            ) : (
              <>
                <section>
                  <PowerTable
                    powers={sb.powers}
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
                    orders={sb.orders[active] ?? {}}
                    allowance={activeSummary?.allowance ?? 0}
                    onRemove={(key) => sb.removeOrder(active, key)}
                    alternative={(text) => viaAlternative(ctx, active, text)}
                    onReplace={(key, text) => {
                      sb.setOrder(active, key, text);
                      announce(describeOrder(text));
                    }}
                  />
                  <div className="row-actions">
                    {sb.kind === "M" ? (
                      <button type="button" className="btn small" onClick={() => sb.holdAll(active)}>
                        Hold the rest
                      </button>
                    ) : null}
                    {sb.kind === "A" && (activeSummary?.allowance ?? 0) > 0 ? (
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => sb.waive(active)}
                        disabled={(activeSummary?.given ?? 0) >= (activeSummary?.allowance ?? 0)}
                      >
                        Waive a build
                      </button>
                    ) : null}
                    <button type="button" className="btn small" onClick={() => sb.clearOrders(active)}>
                      Clear
                    </button>
                  </div>
                </section>
              </>
            )}
          </div>

          <div className="actions">
            {record ? (
              <button type="button" className="btn primary" onClick={() => setViewing(last ? null : viewing! + 1)}>
                {last ? continueLabel(sb.phase) : "Next phase"}
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={adjudicate} disabled={sb.status !== "active"}>
                {resolveLabel(sb.phase)}
              </button>
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
    </>
  );
}

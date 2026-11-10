import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HowToPlay } from "./components/HowToPlay.jsx";
import { OrderList, PhaseHeader, PhaseStepper, PowerTable, Results } from "./components/Sidebar.jsx";
import { Wordmark } from "./Wordmark.jsx";
import {
  type ComposeContext,
  type Draft,
  type Mode,
  type Step,
  click,
  disbandSelected,
  holdSelected,
  setMode,
} from "./game/compose.js";
import {
  choicePrompt,
  choicesFor,
  describeBoard,
  describeOrder,
  describeOutcome,
  phaseLine,
  statusLine,
} from "./game/describe.js";
import { describePhase, parseOrder, parseUnit, provinceOf, titleCase } from "./game/notation.js";
import { useSandbox } from "./game/useSandbox.js";
import { Board, type DrawnOrder } from "./map/Board.jsx";

const SHORTCUTS_KEY = "cabal.shortcuts";

function readShortcuts(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_KEY) !== "off";
  } catch {
    return true;
  }
}

interface Picker {
  x: number;
  y: number;
  title: string;
  power: string;
  key: string;
  options: string[];
}

const IDLE: Draft = { step: "idle" };

export function App() {
  const sb = useSandbox();
  const [draft, setDraft] = useState<Draft>(IDLE);
  const [active, setActive] = useState("FRANCE");
  const [message, setMessage] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [shortcuts, setShortcutsState] = useState(readShortcuts);
  const boardWrap = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const choicesRef = useRef<HTMLElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  /** Set when a keyboard choice (or Escape) removed the focused button, so focus moves on. */
  const refocus = useRef(false);

  const setShortcuts = useCallback((on: boolean) => {
    setShortcutsState(on);
    try {
      localStorage.setItem(SHORTCUTS_KEY, on ? "on" : "off");
    } catch {
      // storage can be unavailable (private windows); the choice still holds for this visit
    }
  }, []);

  const announce = useCallback((text: string) => {
    // Clearing first makes a repeated message announce again.
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(text), 50);
  }, []);

  const ctx = useMemo<ComposeContext | null>(
    () => (sb ? { phase: sb.kind, pieces: sb.pieces, legal: sb.legal } : null),
    [sb],
  );

  const apply = useCallback(
    (step: Step, client?: { x: number; y: number }) => {
      if (!sb) return;
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
        const tall = 34 + effect.options.length * 34;
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
        });
        setMessage(null);
      } else if (effect.kind === "message") {
        setMessage(effect.text);
      } else if (step.draft.step !== "idle") {
        setMessage(null);
      }
    },
    [sb, announce],
  );

  const onProvince = useCallback(
    (code: string, client: { x: number; y: number }) => {
      if (!ctx || viewing !== null || sb?.status !== "active") return;
      setPicker(null);
      apply(click(ctx, draft, code), client);
    },
    [ctx, draft, apply, viewing, sb?.status],
  );

  const mode = useCallback(
    (m: Mode) => {
      if (!ctx) return;
      apply(setMode(ctx, draft, m));
    },
    [ctx, draft, apply],
  );

  const cancel = useCallback(() => {
    // If the focused control (a picker option, Cancel) is about to vanish, move focus on.
    if (document.activeElement?.closest(".picker, .choices, [data-vanishes]")) refocus.current = true;
    setDraft(IDLE);
    setPicker(null);
    setMessage(null);
  }, []);

  const adjudicate = useCallback(() => {
    if (!sb) return;
    const given = new Set(Object.values(sb.orders).flatMap((o) => Object.values(o)));
    const outcome = sb.adjudicate();
    cancel();
    if (outcome) {
      setViewing(sb.history.length);
      announce(describeOutcome(outcome, given));
    }
  }, [sb, cancel, announce]);

  // Say where the player is when they step through the phase history or back to the live phase.
  const lastViewing = useRef<number | null>(null);
  useEffect(() => {
    const was = lastViewing.current;
    lastViewing.current = viewing;
    if (!sb || was === viewing) return;
    // Adjudicating or leaving the results swaps the sidebar and removes the focused button.
    // Land on the button in the same place (Adjudicate, Next phase, Continue) so Enter keeps going.
    if (!document.activeElement || document.activeElement === document.body) {
      document.querySelector<HTMLButtonElement>(".sidebar .actions .btn.primary")?.focus();
    }
    if (viewing === null) {
      announce(statusLine(sb.status) ?? `Now ${phaseLine(sb.phase)}. Give orders for each power.`);
    } else if (was !== null) {
      const record = sb.history[viewing];
      if (record) announce(`Showing the ${phaseLine(record.phase)} results.`);
    }
  }, [viewing, sb, announce]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, select, textarea, dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!ctx) return;
      const key = e.key.toLowerCase();
      // Enter and Space belong to whatever button or link has focus.
      const onControl = Boolean(el.closest("button, a, [role='button']"));
      if (key === "escape") return cancel();
      if (viewing !== null) {
        if ((key === "enter" && !onControl) || key === "arrowright") {
          e.preventDefault();
          setViewing(viewing + 1 >= (sb?.history.length ?? 0) ? null : viewing + 1);
        } else if (key === "arrowleft" && viewing > 0) {
          setViewing(viewing - 1);
        }
        return;
      }
      if (key === "arrowleft" && sb && sb.history.length > 0) return setViewing(sb.history.length - 1);
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
  }, [ctx, draft, mode, apply, cancel, viewing, sb, shortcuts]);

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
    if (!refocus.current && !lost) return;
    refocus.current = false;
    const panel = choicesRef.current;
    const first = panel?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (first ?? panel)?.focus();
  }, [draft, picker, viewing]);

  // provinces the current draft can act on
  const targets = useMemo(() => {
    const set = new Set<string>();
    if (!sb || draft.step === "idle") return set;
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
  }, [sb, draft]);

  if (!sb) {
    return (
      <div className="app loading">
        <TopBar onHelp={() => setHelp(true)} />
        <main className="loading-body">
          <p>Setting up the board.</p>
        </main>
      </div>
    );
  }

  const record = viewing !== null ? sb.history[viewing] : undefined;
  const mapState = record ? record.state : sb.state;
  const given = record ? new Set(Object.values(record.orders).flatMap((o) => Object.values(o))) : null;
  const drawn: DrawnOrder[] = record
    ? record.outcome.results
        .filter((r) => given!.has(r.order) || (!r.ok && parseOrder(r.order)?.type !== "hold"))
        .map((r) => ({ power: r.power, text: r.order, ok: r.ok }))
    : Object.entries(sb.orders).flatMap(([power, entries]) => Object.values(entries).map((text) => ({ power, text })));

  const selectedProvince = draft.step === "idle" ? null : parseUnit(draft.unit)?.province ?? null;
  const { season, year } = describePhase(sb.phase);
  const activeSummary = sb.powers.find((p) => p.power === active);
  const orderableUnits = Object.keys(sb.legal[active] ?? {}).filter((u) => u !== "");
  const choices =
    !record && sb.status === "active" && ctx
      ? choicesFor(ctx, draft, active, orderableUnits, targets, sb.board.provinces)
      : [];
  const choose = (code: string) => {
    if (!ctx || viewing !== null || sb.status !== "active") return;
    setPicker(null);
    refocus.current = true;
    apply(click(ctx, draft, code));
  };
  const boardText = describeBoard(mapState, sb.board.provinces);

  const hint = (() => {
    if (record) return "Showing how the phase resolved. Use the arrows or Enter to step forward.";
    if (sb.status !== "active") return "The game is over. Undo a phase or start a new game.";
    if (message) return message;
    switch (draft.step) {
      case "idle":
        return sb.kind === "A"
          ? "Click an empty home supply centre to build, or a unit to disband."
          : sb.kind === "R"
            ? "Click a dislodged unit, then where it retreats."
            : "Click a unit, then where it should go.";
      case "unit":
        return sb.kind === "R"
          ? `${draft.unit}: click an empty neighbour, or press D to disband.`
          : `${draft.unit}: click a destination, click it again to hold, or press S or C.`;
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
      cancel();
      announce(`Game loaded from ${file.name}.`);
    } catch (err) {
      setMessage(`That file could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to the board
      </a>
      <TopBar onHelp={() => setHelp(true)} />

      <main className="table" id="main" tabIndex={-1}>
        <h1 className="sr-only">Cabal Diplomacy sandbox</h1>
        <div className="board-wrap" ref={boardWrap}>
          <Board
            board={sb.board}
            state={mapState}
            orders={drawn}
            selected={record ? null : selectedProvince}
            targets={record ? undefined : targets}
            standoffs={record?.outcome.standoffs}
            onProvince={onProvince}
          />
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
                  onClick={() => {
                    sb.setOrder(picker.power, picker.key, o);
                    setActive(picker.power);
                    setPicker(null);
                    refocus.current = true;
                    announce(describeOrder(o));
                  }}
                >
                  {o}
                </button>
              ))}
            </div>
          ) : null}

          <div className="toolbar" role="group" aria-label="Order tools">
            {sb.kind === "M" && !record ? (
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
                <button type="button" className="tool" onClick={() => ctx && apply(holdSelected(ctx, draft))}>
                  Hold <kbd>H</kbd>
                </button>
              </>
            ) : null}
            {sb.kind === "R" && !record ? (
              <button type="button" className="tool" onClick={() => ctx && apply(disbandSelected(ctx, draft))}>
                Disband <kbd>D</kbd>
              </button>
            ) : null}
            {draft.step !== "idle" || picker ? (
              <button type="button" className="tool" onClick={cancel} data-vanishes>
                Cancel <kbd>Esc</kbd>
              </button>
            ) : null}
            <p className={`hint${message ? " alert" : ""}`} role="status" aria-live="polite">
              {hint}
            </p>
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
                <p>
                  Units: {p.units.length ? p.units.join("; ") : "none"}.
                </p>
                <p>
                  Supply centres ({p.centers.length}): {p.centers.length ? p.centers.join(", ") : "none"}.
                </p>
              </section>
            ))}
          </details>
        </div>

        <aside className="sidebar">
          <PhaseHeader phase={record ? record.phase : sb.phase} status={sb.status} viewing={Boolean(record)} />
          <PhaseStepper history={sb.history} viewing={viewing} livePhase={sb.phase} onView={setViewing} />

          {record ? (
            <>
              <Results record={record} />
              <div className="actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setViewing(viewing! + 1 >= sb.history.length ? null : viewing! + 1)}
                >
                  {viewing! + 1 >= sb.history.length ? `Continue to ${describePhase(sb.phase).season} ${describePhase(sb.phase).year}` : "Next phase"}
                </button>
              </div>
            </>
          ) : (
            <>
              <section>
                <PowerTable powers={sb.powers} active={active} kind={sb.kind} onSelect={setActive} />
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
                />
                <div className="row-actions">
                  {sb.kind === "M" ? (
                    <button type="button" className="btn small" onClick={() => sb.holdAll(active)}>
                      Hold the rest
                    </button>
                  ) : null}
                  {sb.kind === "A" && (activeSummary?.allowance ?? 0) > 0 ? (
                    <button type="button" className="btn small" onClick={() => sb.waive(active)}>
                      Waive a build
                    </button>
                  ) : null}
                  <button type="button" className="btn small" onClick={() => sb.clearOrders(active)}>
                    Clear
                  </button>
                </div>
              </section>
              <div className="actions">
                <button type="button" className="btn primary" onClick={adjudicate} disabled={sb.status !== "active"}>
                  Adjudicate {season} {year}
                </button>
              </div>
            </>
          )}

          <section className="game-tools">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                sb.undo();
                announce("Last phase undone.");
              }}
              disabled={sb.history.length === 0}
            >
              Undo last phase
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                if (sb.history.length === 0 || window.confirm("Start a new game? This board will be lost.")) {
                  sb.reset();
                  setViewing(null);
                  cancel();
                  announce("New game started: Spring 1901 movement.");
                }
              }}
            >
              New game
            </button>
            <button type="button" className="btn small" onClick={download}>
              Export
            </button>
            <button type="button" className="btn small" onClick={() => fileInput.current?.click()}>
              Import
            </button>
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={upload} />
          </section>
        </aside>
      </main>

      <footer className="footer">
        <span>Sandbox: every power is yours to order.</span>
        <span>Adjudicated in your browser by a Rust engine that passes all 171 DATC cases.</span>
        <span>Board drawn from Natural Earth.</span>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
        <a href="/privacy">Privacy</a>
        <a href="/llms.txt">llms.txt</a>
        <a href="https://github.com/KarthikSubramanian07/Cabal">Source</a>
      </footer>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <HowToPlay open={help} onClose={() => setHelp(false)} shortcuts={shortcuts} onShortcuts={setShortcuts} />
    </div>
  );
}

function TopBar({ onHelp }: { onHelp: () => void }) {
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Cabal home">
        <Wordmark height={22} color="var(--bone)" />
      </a>
      <nav>
        <span className="nav-current">Sandbox</span>
        <button type="button" onClick={onHelp}>
          How to play
        </button>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
        <a href="https://github.com/KarthikSubramanian07/Cabal">GitHub</a>
      </nav>
    </header>
  );
}

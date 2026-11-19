/**
 * The sandbox: a whole game driven by the in-browser engine. Every power can be
 * ordered from one screen, every phase is kept for replay, the game is saved on this
 * device as it is played, and games can be exported and imported in the MILA saved
 * game format.
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Game, type PhaseOutcome, type State, engineReady } from "../engine.js";
import { type Board, loadBoard } from "../map/boardData.js";
import { type OrderBook, eraseOrder, flatten, keepLegal, waiveBuild, writeOrder } from "./book.js";
import type { Piece } from "./compose.js";
import { POWER_NAMES, type PhaseKind, parseUnit, phaseKind } from "./notation.js";
import { clearSave, readSave, writeSave } from "./persist.js";
import { type Loaded, type PhaseRecord, loadSaved, replay, tidyLegal, tidyOutcome } from "./saved.js";
import { type TrackedHistory, trackUnits } from "./unitIds.js";

export type { OrderBook } from "./book.js";
export type { PhaseRecord } from "./saved.js";

/** A saved game that has been read and checked but not put on the board yet. */
export interface OpenedGame {
  /** The phase it would resume at. */
  phase: string;
  /** How many phases it has resolved. */
  resolved: number;
  /** Replace the game on the board with this one. */
  load: () => void;
}

export interface PowerSummary {
  power: string;
  centers: number;
  units: number;
  /** Units (or builds and disbands) that need an order this phase. */
  due: number;
  /** Orders written so far. */
  given: number;
  /** Adjustment phases: builds (positive) or disbands (negative) owed. */
  allowance: number;
}

export interface Sandbox {
  board: Board;
  phase: string;
  kind: PhaseKind;
  status: string;
  state: State;
  pieces: Piece[];
  legal: Record<string, Record<string, string[]>>;
  /** Adjustment phases: builds (positive) or disbands (negative) owed, by power. */
  allowance: Record<string, number>;
  powers: PowerSummary[];
  orders: OrderBook;
  history: PhaseRecord[];
  /** Stable unit identities for every recorded position and the live one. */
  units: TrackedHistory;
  /** Set when this visit began by restoring a saved game: the phase it was restored at. */
  resumed: string | null;
  dismissResumed: () => void;
  /** The power that was open when the game was saved, if it was restored. */
  resumedActive: string | null;
  setOrder: (power: string, key: string, text: string) => void;
  removeOrder: (power: string, key: string) => void;
  clearOrders: (power?: string) => void;
  holdAll: (power: string) => void;
  waive: (power: string) => void;
  adjudicate: () => PhaseOutcome | null;
  undo: () => void;
  reset: () => void;
  exportSaved: () => string;
  /** Throws `ImportError` with a message fit to show when the text is not a saved game. */
  importSaved: (json: string) => void;
  /** Remember which power is open, for the autosave. */
  noteActive: (power: string) => void;
}

export type SandboxLoad =
  | { status: "loading" }
  | { status: "error"; error: Error; retry: () => void }
  | { status: "ready"; sandbox: Sandbox };

export function useSandbox(): SandboxLoad {
  const [board, setBoard] = useState<Board | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [version, setVersion] = useState(0);
  const [orders, setOrders] = useState<OrderBook>({});
  const [history, setHistory] = useState<PhaseRecord[]>([]);
  const [resumed, setResumed] = useState<string | null>(null);
  const [resumedActive, setResumedActive] = useState<string | null>(null);
  /** The power whose orders are open. Kept here so that choosing one is saved like any other change. */
  const [active, setActive] = useState<string>("FRANCE");

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([engineReady(), loadBoard()]).then(
      ([, b]) => {
        if (!live) return;
        // Pick up the game saved on this device, if there is one this build can read.
        let loaded: Loaded | null = null;
        const save = readSave();
        if (save) {
          try {
            loaded = loadSaved(save.game, save.written);
          } catch {
            // A save that no longer loads is worth less than a working board.
            clearSave();
          }
        }
        const game = loaded?.game ?? new Game();
        // Drawing the board for the first time is the heaviest render there is. As a
        // transition React does it in slices, so the page stays responsive meanwhile.
        startTransition(() => {
          setBoard(b);
          setGame(game);
          if (loaded && save) {
            setHistory(loaded.history);
            setOrders(save.orders);
            setActive(save.active);
            setResumedActive(save.active);
            setResumed(game.phase());
          }
        });
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const bump = () => setVersion((v) => v + 1);

  // `version` is the invalidation signal for the mutable engine object.
  const snapshot = useMemo(() => {
    if (!game) return null;
    void version;
    const phase = game.phase();
    const status = game.status();
    const state = game.state();
    const kind = phaseKind(state.name);
    const legal: Record<string, Record<string, string[]>> = {};
    const allowance: Record<string, number> = {};
    if (status === "active") {
      for (const power of POWER_NAMES) {
        const l = game.legal(power);
        legal[power] = tidyLegal(l.by_unit, kind);
        allowance[power] = l.allowance;
      }
    }
    return { phase, status, state, kind, legal, allowance };
  }, [game, version]);

  // Orders restored from a save are only as good as the phase they were written for.
  const checked = useRef<Game | null>(null);
  useEffect(() => {
    if (!snapshot || !game || checked.current === game) return;
    checked.current = game;
    setOrders((o) => {
      const kept = keepLegal(o, snapshot.legal, snapshot.kind);
      return JSON.stringify(kept) === JSON.stringify(o) ? o : kept;
    });
  }, [snapshot, game]);

  const pieces = useMemo<Piece[]>(() => {
    if (!snapshot) return [];
    const list: Piece[] = [];
    for (const [power, units] of Object.entries(snapshot.state.units)) {
      for (const u of units) {
        const ref = parseUnit(u);
        if (ref) list.push({ power, unit: ref.unit, province: ref.province, dislodged: u.startsWith("*") });
      }
    }
    return list;
  }, [snapshot]);

  const powers = useMemo<PowerSummary[]>(() => {
    if (!snapshot) return [];
    return POWER_NAMES.map((power) => {
      const centers = snapshot.state.centers[power]?.length ?? 0;
      const units = pieces.filter((p) => p.power === power && !p.dislodged).length;
      const legal = snapshot.legal[power] ?? {};
      const allowance = snapshot.allowance[power] ?? 0;
      const given = Object.keys(orders[power] ?? {}).length;
      const due = snapshot.kind === "A" ? Math.abs(allowance) : Object.keys(legal).length;
      return { power, centers, units, due, given, allowance };
    });
  }, [snapshot, pieces, orders]);

  const units = useMemo<TrackedHistory>(
    () => (snapshot ? trackUnits(history, snapshot.state) : { phases: [], live: {} }),
    [history, snapshot],
  );

  // Save after every change. A board nobody has touched is not worth a save.
  useEffect(() => {
    if (!game || !snapshot) return;
    const touched = history.length > 0 || Object.values(orders).some((o) => Object.keys(o).length > 0);
    if (!touched) {
      clearSave();
      return;
    }
    writeSave({
      savedAt: Date.now(),
      game: game.toSaved("cabal-sandbox"),
      written: history.map((h) => h.orders),
      orders,
      active,
    });
  }, [game, snapshot, orders, history, active]);

  const setOrder = useCallback(
    (power: string, key: string, text: string) => {
      if (!snapshot) return;
      const cap = { kind: snapshot.kind, allowance: snapshot.allowance[power] ?? 0 };
      setOrders((o) => writeOrder(o, power, key, text, cap));
    },
    [snapshot],
  );

  const removeOrder = useCallback((power: string, key: string) => {
    setOrders((o) => eraseOrder(o, power, key));
  }, []);

  const clearOrders = useCallback((power?: string) => {
    setOrders((o) => (power ? { ...o, [power]: {} } : {}));
  }, []);

  const holdAll = useCallback(
    (power: string) => {
      if (!snapshot || snapshot.kind !== "M") return;
      const legal = snapshot.legal[power] ?? {};
      setOrders((o) => {
        const next = { ...o[power] };
        for (const unit of Object.keys(legal)) next[unit] ??= `${unit} H`;
        return { ...o, [power]: next };
      });
    },
    [snapshot],
  );

  const waive = useCallback(
    (power: string) => {
      if (!snapshot || snapshot.kind !== "A") return;
      setOrders((o) => waiveBuild(o, power, snapshot.allowance[power] ?? 0));
    },
    [snapshot],
  );

  const adjudicate = useCallback((): PhaseOutcome | null => {
    if (!game || !snapshot || snapshot.status !== "active") return null;
    const outcome = tidyOutcome(game.process(game.normaliseOrders({ orders: flatten(orders) })));
    setHistory((h) => [...h, { phase: snapshot.phase, state: snapshot.state, orders, outcome }]);
    setOrders({});
    setResumed(null);
    bump();
    return outcome;
  }, [game, snapshot, orders]);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const last = history.at(-1)!;
    const rebuilt = replay(history.slice(0, -1), history[0]!.state);
    setGame(rebuilt.game);
    setHistory(rebuilt.history);
    setOrders(last.orders);
    bump();
  }, [history]);

  const reset = useCallback(() => {
    setGame(new Game());
    setHistory([]);
    setOrders({});
    setResumed(null);
    clearSave();
    bump();
  }, []);

  const exportSaved = useCallback(() => game?.toSaved("cabal-sandbox") ?? "", [game]);

  const importSaved = useCallback((json: string) => {
    const loaded = loadSaved(json);
    return {
      phase: loaded.game.phase(),
      resolved: loaded.history.length,
      load: () => {
        setGame(loaded.game);
        setHistory(loaded.history);
        setOrders({});
        setResumed(null);
        bump();
      },
    };
  }, []);

  const dismissResumed = useCallback(() => setResumed(null), []);
  const noteActive = useCallback((power: string) => setActive(power), []);

  if (error) return { status: "error", error, retry };
  if (!board || !game || !snapshot) return { status: "loading" };
  return {
    status: "ready",
    sandbox: {
      board,
      phase: snapshot.phase,
      kind: snapshot.kind,
      status: snapshot.status,
      state: snapshot.state,
      pieces,
      legal: snapshot.legal,
      allowance: snapshot.allowance,
      powers,
      orders,
      history,
      units,
      resumed,
      dismissResumed,
      resumedActive,
      setOrder,
      removeOrder,
      clearOrders,
      holdAll,
      waive,
      adjudicate,
      undo,
      reset,
      exportSaved,
      importSaved,
      noteActive,
    },
  };
}

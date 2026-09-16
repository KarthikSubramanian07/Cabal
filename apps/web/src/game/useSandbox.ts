/**
 * The sandbox: a whole game driven by the in-browser engine. Every power can be
 * ordered from one screen, every phase is kept for replay, and games can be
 * exported and imported in the MILA saved game format.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Game, type PhaseOutcome, type State, engineReady } from "../engine.js";
import { type Board, loadBoard } from "../map/boardData.js";
import type { Piece } from "./compose.js";
import { POWER_NAMES, type PhaseKind, parseUnit, phaseKind } from "./notation.js";

/** Orders keyed by power, then by unit (or `B:PAR` / `D:PAR` / `WAIVE:n` in adjustments). */
export type OrderBook = Record<string, Record<string, string>>;

export interface PhaseRecord {
  phase: string;
  /** The board as the phase began. */
  state: State;
  orders: OrderBook;
  outcome: PhaseOutcome;
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
  powers: PowerSummary[];
  orders: OrderBook;
  history: PhaseRecord[];
  setOrder: (power: string, key: string, text: string) => void;
  removeOrder: (power: string, key: string) => void;
  clearOrders: (power?: string) => void;
  holdAll: (power: string) => void;
  waive: (power: string) => void;
  adjudicate: () => PhaseOutcome | null;
  undo: () => void;
  reset: () => void;
  exportSaved: () => string;
  importSaved: (json: string) => void;
}

function toBook(orders: Record<string, string[]>, kind: PhaseKind): OrderBook {
  const book: OrderBook = {};
  for (const [power, list] of Object.entries(orders)) {
    const entries: Record<string, string> = {};
    list.forEach((text, i) => {
      if (kind === "A") {
        const unit = parseUnit(text);
        const key = text === "WAIVE" ? `WAIVE:${i}` : `${text.trim().endsWith(" D") ? "D" : "B"}:${unit?.province}`;
        entries[key] = text;
      } else {
        const unit = parseUnit(text);
        if (unit) entries[unit.unit] = text;
      }
    });
    book[power] = entries;
  }
  return book;
}

function flatten(book: OrderBook): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [power, entries] of Object.entries(book)) out[power] = Object.values(entries);
  return out;
}

export function useSandbox(): Sandbox | null {
  const [board, setBoard] = useState<Board | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [version, setVersion] = useState(0);
  const [orders, setOrders] = useState<OrderBook>({});
  const [history, setHistory] = useState<PhaseRecord[]>([]);

  useEffect(() => {
    let live = true;
    Promise.all([engineReady(), loadBoard()]).then(([, b]) => {
      if (!live) return;
      setBoard(b);
      setGame(new Game());
    });
    return () => {
      live = false;
    };
  }, []);

  const bump = () => setVersion((v) => v + 1);

  // biome-ignore lint: version is the invalidation signal for the mutable engine object
  const snapshot = useMemo(() => {
    if (!game) return null;
    const phase = game.phase();
    const status = game.status();
    const state = game.state();
    const kind = phaseKind(state.name);
    const legal: Record<string, Record<string, string[]>> = {};
    const allowance: Record<string, number> = {};
    if (status === "active") {
      for (const power of POWER_NAMES) {
        const l = game.legal(power);
        legal[power] = l.by_unit;
        allowance[power] = l.allowance;
      }
    }
    return { phase, status, state, kind, legal, allowance };
  }, [game, version]);

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
      let due = 0;
      if (snapshot.kind === "A") due = Math.abs(allowance);
      else due = Object.keys(legal).length;
      return { power, centers, units, due, given, allowance };
    });
  }, [snapshot, pieces, orders]);

  const setOrder = useCallback((power: string, key: string, text: string) => {
    setOrders((o) => ({ ...o, [power]: { ...o[power], [key]: text } }));
  }, []);

  const removeOrder = useCallback((power: string, key: string) => {
    setOrders((o) => {
      const next = { ...o[power] };
      delete next[key];
      return { ...o, [power]: next };
    });
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
      setOrders((o) => {
        const current = o[power] ?? {};
        const used = Object.keys(current).length;
        if (used >= (snapshot.allowance[power] ?? 0)) return o;
        return { ...o, [power]: { ...current, [`WAIVE:${used}`]: "WAIVE" } };
      });
    },
    [snapshot],
  );

  const adjudicate = useCallback((): PhaseOutcome | null => {
    if (!game || !snapshot || snapshot.status !== "active") return null;
    const outcome = game.process({ orders: flatten(orders) });
    setHistory((h) => [...h, { phase: snapshot.phase, state: snapshot.state, orders, outcome }]);
    setOrders({});
    bump();
    return outcome;
  }, [game, snapshot, orders]);

  const replay = (records: PhaseRecord[], origin: State) => {
    const g = Game.fromState(origin);
    const rebuilt: PhaseRecord[] = [];
    for (const r of records) {
      const state = g.state();
      const outcome = g.process({ orders: flatten(r.orders) });
      rebuilt.push({ phase: r.phase, state, orders: r.orders, outcome });
    }
    return { g, rebuilt };
  };

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const last = history.at(-1)!;
    const { g, rebuilt } = replay(history.slice(0, -1), history[0]!.state);
    setGame(g);
    setHistory(rebuilt);
    setOrders(last.orders);
    bump();
  }, [history]);

  const reset = useCallback(() => {
    setGame(new Game());
    setHistory([]);
    setOrders({});
    bump();
  }, []);

  const exportSaved = useCallback(() => game?.toSaved("cabal-sandbox") ?? "", [game]);

  const importSaved = useCallback((json: string) => {
    const saved = JSON.parse(json) as { phases: { name: string; state: State; orders: Record<string, string[]> }[] };
    const g = Game.fromSaved(json);
    const records: PhaseRecord[] = saved.phases.slice(0, g.historyLength()).map((p, i) => ({
      phase: p.name,
      state: p.state,
      orders: toBook(p.orders, phaseKind(p.name)),
      outcome: g.outcome(i),
    }));
    setGame(g);
    setHistory(records);
    setOrders({});
    bump();
  }, []);

  if (!board || !game || !snapshot) return null;
  return {
    board,
    phase: snapshot.phase,
    kind: snapshot.kind,
    status: snapshot.status,
    state: snapshot.state,
    pieces,
    legal: snapshot.legal,
    powers,
    orders,
    history,
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
  };
}

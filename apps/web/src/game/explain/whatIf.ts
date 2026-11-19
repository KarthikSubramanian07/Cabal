/**
 * What if: sketch orders for any powers and see how the phase would resolve, without touching
 * the game. The sketch is a separate order book; nothing here writes to the game, the history
 * or the network. `predict` is the engine's `preview` (and, for movement, `explainPreview`) on
 * the position as it stands, so the prediction is exactly what adjudicating those orders gives.
 */
import { useCallback, useMemo, useState } from "react";
import { type Explanation, type PhaseOutcome, type State, explainPreview, preview } from "@cabal/engine";
import { type OrderBook, eraseOrder, flatten } from "../book.js";
import { type PhaseKind, phaseKind } from "../notation.js";

export interface Prediction {
  outcome: PhaseOutcome;
  /** Movement phases only. */
  explanation: Explanation | null;
}

/** The outcome (and, for movement, the explanation) these orders would have from `state`. */
export function predict(state: State, book: OrderBook): Prediction | null {
  try {
    const orders = { orders: flatten(book) };
    const outcome = preview(state, orders);
    let explanation: Explanation | null = null;
    if (phaseKind(state.name) === "M") {
      try {
        explanation = explainPreview(state, orders);
      } catch {
        explanation = null;
      }
    }
    return { outcome, explanation };
  } catch {
    return null;
  }
}

export interface WhatIf {
  /** Whether a sketch is open. */
  on: boolean;
  /** The sketched orders (empty when off). */
  orders: OrderBook;
  /** How the sketch would resolve, recomputed as it changes. */
  prediction: Prediction | null;
  /** Open a sketch, starting from `from` (the orders written so far, or nothing). */
  start: (from?: OrderBook) => void;
  /** Throw the sketch away. */
  stop: () => void;
  setOrder: (power: string, key: string, text: string) => void;
  removeOrder: (power: string, key: string) => void;
  clearOrders: (power?: string) => void;
  /** Every unit of `power` without a sketched order holds (movement phases). */
  holdAll: (power: string, units: readonly string[]) => void;
}

/**
 * A sketch over the position `state`. It belongs to whoever renders it: the sandbox, or a
 * room where the player may only send orders for one power but may guess at all of them.
 */
export function useWhatIf(state: State, kind: PhaseKind): WhatIf {
  const [sketch, setSketch] = useState<OrderBook | null>(null);
  const start = useCallback((from?: OrderBook) => {
    setSketch(Object.fromEntries(Object.entries(from ?? {}).map(([p, o]) => [p, { ...o }])));
  }, []);
  const stop = useCallback(() => setSketch(null), []);
  const setOrder = useCallback((power: string, key: string, text: string) => {
    setSketch((s) => (s ? { ...s, [power]: { ...s[power], [key]: text } } : s));
  }, []);
  const removeOrder = useCallback((power: string, key: string) => {
    setSketch((s) => (s ? eraseOrder(s, power, key) : s));
  }, []);
  const clearOrders = useCallback((power?: string) => {
    setSketch((s) => (s ? (power ? { ...s, [power]: {} } : {}) : s));
  }, []);
  const holdAll = useCallback(
    (power: string, units: readonly string[]) => {
      if (kind !== "M") return;
      setSketch((s) => {
        if (!s) return s;
        const next = { ...s[power] };
        for (const unit of units) next[unit] ??= `${unit} H`;
        return { ...s, [power]: next };
      });
    },
    [kind],
  );
  const prediction = useMemo(() => (sketch ? predict(state, sketch) : null), [sketch, state]);
  return {
    on: sketch !== null,
    orders: sketch ?? {},
    prediction,
    start,
    stop,
    setOrder,
    removeOrder,
    clearOrders,
    holdAll,
  };
}

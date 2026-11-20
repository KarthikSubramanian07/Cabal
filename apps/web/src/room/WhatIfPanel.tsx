/**
 * The what-if section of a live room's order desk: what the sketch is, whose orders the map and
 * the choices are guessing at, the engine's predicted results, and the way out. Nothing here
 * files anything; "Use my sketched orders" hands the seat's own sketch to the order desk, which
 * files it like any order written on the map.
 */
import type { CSSProperties } from "react";
import type { OrderResult } from "@cabal/engine";
import { Results } from "../components/Sidebar.jsx";
import type { OrderBook } from "../game/book.js";
import type { Why } from "../game/explain/explain.js";
import type { Names } from "../game/receipts.js";
import type { Prediction } from "../game/explain/whatIf.js";
import { titleCase } from "../game/notation.js";
import { POWER_COLOR } from "../map/Board.jsx";

export function WhatIfPanel({
  me,
  phase,
  powers,
  guessing,
  onGuess,
  orders,
  prediction,
  names,
  explain,
  open,
  onOpen,
  onUse,
  onDiscard,
}: {
  me: string;
  phase: string;
  /** The powers that can be sketched for, the seat's own first. */
  powers: readonly string[];
  /** Whose orders the choices under the map are writing. */
  guessing: string;
  onGuess: (power: string) => void;
  orders: OrderBook;
  prediction: Prediction | null;
  names: Names;
  explain?: ((r: OrderResult) => Why | null) | undefined;
  open: string | null;
  onOpen: (key: string | null) => void;
  onUse: () => void;
  onDiscard: () => void;
}) {
  const mine = Object.keys(orders[me] ?? {}).length;
  return (
    <section className="what-if-panel" aria-labelledby="what-if-title">
      <h2 id="what-if-title">
        <span className="what-if-stamp">What if</span>
      </h2>
      <p className="hint">
        Sketch your orders and guess at everyone else&apos;s, on the map or below. Units nobody guesses for hold. The prediction is
        the engine&apos;s own, run on this device: nothing is sent and nobody sees the sketch.
      </p>
      <div className="guess-for" role="group" aria-label="Sketch orders for">
        {powers.map((p) => (
          <button
            key={p}
            type="button"
            className="tool"
            aria-pressed={p === guessing}
            onClick={() => onGuess(p)}
            style={{ "--power": POWER_COLOR[p] } as CSSProperties}
          >
            <span className="swatch" aria-hidden="true" />
            {p === me ? "You" : titleCase(p)}{" "}
            <span className="guess-n">
              {Object.keys(orders[p] ?? {}).length}
              <span className="sr-only"> {Object.keys(orders[p] ?? {}).length === 1 ? "order" : "orders"}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="row-actions">
        <button type="button" className="btn small" onClick={onUse} disabled={mine === 0}>
          Use my sketched orders
        </button>
        <button type="button" className="btn small" onClick={onDiscard}>
          Discard
        </button>
      </div>
      {prediction ? (
        <Results
          record={{ phase, orders, outcome: prediction.outcome }}
          names={names}
          explain={explain}
          open={open}
          onOpen={onOpen}
          label="Predicted results"
        />
      ) : (
        <p className="hint">These orders cannot be judged together yet.</p>
      )}
    </section>
  );
}

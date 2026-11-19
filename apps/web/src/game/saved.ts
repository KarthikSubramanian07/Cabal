/**
 * Turning a saved game back into a game and its phase records, and replaying records
 * through the engine. No React here, so the rules for what counts as a written order are
 * unit tested against the real engine.
 *
 * A saved game (the MILA format Export writes) lists the orders as adjudicated: every unit
 * has one, including the units nobody ordered. What the player actually wrote is kept
 * alongside it in the autosave, one order book per resolved phase.
 */
import { Game, type PhaseOutcome, type State } from "@cabal/engine";
import { type OrderBook, flatten, toBook } from "./book.js";
import { type PhaseKind, forUnit, parseOrder, parseUnit, phaseKind } from "./notation.js";
import { ImportError, parseSavedGame } from "./persist.js";

export interface PhaseRecord {
  phase: string;
  /** The board as the phase began. */
  state: State;
  /** What was written for the phase. Units left alone are not in here. */
  orders: OrderBook;
  outcome: PhaseOutcome;
}

export interface Loaded {
  game: Game;
  history: PhaseRecord[];
}

/** Retreat results name the unit that retreated (see `forUnit`). */
export function tidyOutcome(outcome: PhaseOutcome): PhaseOutcome {
  if (phaseKind(outcome.phase) !== "R") return outcome;
  return { ...outcome, results: outcome.results.map((r) => (r.unit ? { ...r, order: forUnit(r.order, r.unit) } : r)) };
}

/** Legal orders by unit, with retreat orders naming the unit they belong to. */
export function tidyLegal(byUnit: Record<string, string[]>, kind: PhaseKind): Record<string, string[]> {
  if (kind !== "R") return byUnit;
  return Object.fromEntries(Object.entries(byUnit).map(([unit, options]) => [unit, options.map((o) => forUnit(o, unit))]));
}

/**
 * The order book a saved phase can vouch for. The file cannot say which orders were written
 * and which the engine filled in, so the ones a unit follows without being told (a hold in
 * a movement phase, a disband in a retreat phase) are left out. Replaying the book gives the
 * same result either way.
 */
export function bookFromSaved(orders: Record<string, string[]>, phase: string, state: State): OrderBook {
  const kind = phaseKind(phase);
  if (kind === "A") return toBook(orders, kind);
  const dislodged = Object.values(state.units ?? {})
    .flat()
    .filter((u) => u.startsWith("*"))
    .flatMap((u) => parseUnit(u) ?? []);
  const kept: Record<string, string[]> = {};
  for (const [power, list] of Object.entries(orders)) {
    const mine: string[] = [];
    for (const raw of list) {
      const province = parseUnit(raw)?.province;
      const owner = kind === "R" ? dislodged.find((d) => d.province === province) : undefined;
      const text = owner ? forUnit(raw, owner.unit) : raw;
      const type = parseOrder(text)?.type;
      if ((kind === "M" && type === "hold") || (kind === "R" && type === "disband")) continue;
      mine.push(text);
    }
    if (mine.length) kept[power] = mine;
  }
  return toBook(kept, kind);
}

/** Play a list of order books through the engine from a starting position. */
export function replay(records: readonly { phase: string; orders: OrderBook }[], origin: State): Loaded {
  const game = Game.fromState(origin);
  const history: PhaseRecord[] = [];
  for (const r of records) {
    const state = game.state();
    const outcome = tidyOutcome(game.process(game.normaliseOrders({ orders: flatten(r.orders) })));
    history.push({ phase: r.phase, state, orders: r.orders, outcome });
  }
  return { game, history };
}

/** A position as text, the same however the engine happened to list its units. */
function fingerprint(game: Game): string {
  const state = game.state();
  const sorted = (by: Record<string, string[]>) =>
    Object.keys(by)
      .sort()
      .map((power) => [power, [...(by[power] ?? [])].sort()]);
  return JSON.stringify([state.name, game.status(), sorted(state.units), sorted(state.centers)]);
}

/**
 * Build a game and its phase records from saved-game JSON. `written` is what the player
 * wrote in each resolved phase, when that is known (the autosave keeps it). It is only
 * believed if replaying it reaches the very position the saved game does; otherwise, and
 * for an imported file, the records fall back to `bookFromSaved`.
 *
 * Throws `ImportError` with a message fit to show when the text is not a saved game.
 */
export function loadSaved(json: string, written?: readonly OrderBook[]): Loaded {
  const saved = parseSavedGame(json);
  let game: Game;
  try {
    game = Game.fromSaved(json);
  } catch (err) {
    throw new ImportError(
      "That file is not a Cabal game export. The engine could not replay it.",
      err instanceof Error ? err.message : String(err),
    );
  }
  const phases = saved.phases.slice(0, game.historyLength());
  const origin = phases[0]?.state as State | undefined;
  if (origin && written && written.length === phases.length) {
    try {
      const mine = replay(
        phases.map((p, i) => ({ phase: p.name, orders: written[i]! })),
        origin,
      );
      if (fingerprint(mine.game) === fingerprint(game)) return mine;
    } catch {
      // Not the orders this game was played with. Fall back to what the file can vouch for.
    }
  }
  const history: PhaseRecord[] = phases.map((p, i) => ({
    phase: p.name,
    state: p.state as State,
    orders: bookFromSaved(p.orders ?? {}, p.name, p.state as State),
    outcome: tidyOutcome(game.outcome(i)),
  }));
  return { game, history };
}

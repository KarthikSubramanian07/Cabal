/**
 * The built-in bot: the brain behind every AI seat unless a game opts into Claude, the cover for
 * seats in civil disorder, and the fallback whenever a Claude turn is late, fails or is over budget.
 *
 * It is the Rust heuristic bot (`crates/cabal-bot`), compiled into the engine module and reached
 * through `botOrders` from `@cabal/engine`. It runs inside the GameRoom, costs nothing and answers
 * in a few milliseconds, so an AI seat can never hold a phase up. Its decisions are deterministic
 * for a given game, phase, power and seed, which keeps replays and tests reproducible, and unlike
 * a random walk it supports its own attacks: bot games see dislodgements, retreats and
 * eliminations.
 */
import type { Game } from "./engine.js";
import { botOrders as engineBotOrders } from "./engine.js";

/**
 * Orders for `power` in the game's current phase: one per unit, builds and disbands filled to the
 * allowance. Empty when the power has nothing to order. Never throws: a seat the bot cannot play
 * is left without orders (its units hold) and the phase resolves all the same.
 */
export function botOrders(game: Game, power: string, seed: string): string[] {
  try {
    return engineBotOrders(game, power, { seed }).orders;
  } catch {
    return [];
  }
}

/** True when the power has at least one order to give this phase. */
export function canAct(game: Game, power: string): boolean {
  const legal = game.legal(power);
  if (game.phase().endsWith("A")) return legal.allowance !== 0;
  return Object.values(legal.by_unit).some((options) => options.length > 0);
}

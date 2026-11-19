/**
 * SeatBrain: the one seam through which every AI seat is played.
 *
 * Every brain can produce orders at once, inside the GameRoom, with no network and no cost. The
 * room files those orders for every AI seat the moment a phase opens, so a seat is never without
 * orders and a phase is never lost, whatever happens afterwards.
 *
 * A brain that `deliberates` is then also asked, outside the room, for something better: a turn
 * goes on the queue, the consumer talks to the model, and the answer replaces the orders on file
 * if it arrives in time. If it does not (timeout, failure, budget, queue down), nothing needs to
 * happen: the orders already on file are adjudicated.
 *
 * `botBrain` is the Rust heuristic bot (`botOrders` from `@cabal/engine`, wrapped in bot.ts).
 */
import { botOrders } from "./bot.js";
import type { Game } from "./engine.js";

export interface SeatBrain {
  readonly id: "bot" | "claude";
  /** Legal orders for `power` in the game's current phase, deterministic for a given seed. */
  orders(game: Game, power: string, seed: string): string[];
  /** True when the brain also thinks outside the room and may replace `orders` before the phase closes. */
  readonly deliberates: boolean;
}

/**
 * Where the in-room bot's orders come from. A seam for tests only, like `agentRuntime` for Claude:
 * most suites are about the room, not about tactics, and swap in a bot that never fights.
 */
export const botRuntime: { orders: (game: Game, power: string, seed: string) => string[] } = { orders: botOrders };

/** The default: free, instant, inside the Durable Object. */
export const botBrain: SeatBrain = {
  id: "bot",
  orders: (game, power, seed) => botRuntime.orders(game, power, seed),
  deliberates: false,
};

/** Claude, through the queue. Its in-room orders are the bot's: the floor it can only improve on. */
export const claudeBrain: SeatBrain = {
  id: "claude",
  orders: botBrain.orders,
  deliberates: true,
};

/**
 * Which brain plays a game's AI seats. Claude is opt-in three times over: the game must ask for
 * it, the server must hold a key, and the queue must be bound. Anything less is the bot.
 */
export function seatBrain(game: { aiBrain: "bot" | "claude" }, server: { hasKey: boolean; hasQueue: boolean }): SeatBrain {
  return game.aiBrain === "claude" && server.hasKey && server.hasQueue ? claudeBrain : botBrain;
}

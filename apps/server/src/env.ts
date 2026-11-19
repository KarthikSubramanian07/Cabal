import type { GameRoom } from "./room.js";
import type { Registry } from "./registry.js";

/**
 * One Claude turn for one AI seat: one model call. It names the phase and the step, so a message
 * that arrives late is dropped, never replayed. It carries no credential: the consumer reaches the
 * room through the Durable Object binding, which is the trust boundary.
 */
export interface AgentTurn {
  gameId: string;
  power: string;
  phase: string;
  /** `negotiate` opens a movement phase with press; `order` closes every phase with orders. */
  step: "negotiate" | "order";
}

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  /** Singleton global index of finished and abandoned games (`idFromName("global")`). */
  REGISTRY?: DurableObjectNamespace<Registry>;
  /** Claude turns for games that opted into `aiBrain: "claude"`. The built-in bot needs no queue. */
  AGENT_QUEUE?: Queue<AgentTurn>;
  /** Secret. Without it every AI seat is played by the built-in bot. */
  ANTHROPIC_API_KEY?: string;
  /** Hard cap on Claude turns (one seat, one phase) per game; the bot plays every turn after it. Defaults to 400. */
  CLAUDE_TURNS_PER_GAME?: string;
  /** Hard cap on what one game may spend on Claude, in US dollars; the bot plays on after it. Defaults to 5. */
  CLAUDE_USD_PER_GAME?: string;
  /** What every game together may commit to Claude in one UTC day, in US dollars. Read by the Registry. Defaults to 20. */
  CLAUDE_USD_PER_DAY?: string;
  /** How many games with Claude seats may be in play at once. Read by the Registry. Defaults to 4. */
  CLAUDE_ACTIVE_GAMES?: string;
  /** Identifies the deployed build in `/health` and error logs. Set at deploy time; optional. */
  BUILD_ID?: string;
  /** Worker version metadata: the build id when `BUILD_ID` is not set. */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  /** Per-seat limit on press. */
  PRESS_LIMITER?: RateLimit;
  /** Per-IP limit on creating games. Optional so tests and local dev run without it. */
  CREATE_LIMITER?: RateLimit;
  /** Per-IP limit on joining games and issuing substitute invites. */
  JOIN_LIMITER?: RateLimit;
  /** Per-IP limit on reads, starts and socket upgrades: each one can wake a room. */
  READ_LIMITER?: RateLimit;
}

import type { GameRoom } from "./room.js";
import type { Registry } from "./registry.js";

/** One Claude turn for one AI seat. It names a phase so a late message is dropped, never replayed. */
export interface AgentTurn {
  gameId: string;
  power: string;
  phase: string;
}

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  /** Singleton global index of finished and abandoned games (`idFromName("global")`). */
  REGISTRY?: DurableObjectNamespace<Registry>;
  /** Claude turns for games that opted into `aiBrain: "claude"`. The built-in bot needs no queue. */
  AGENT_QUEUE?: Queue<AgentTurn>;
  /** Secret. Without it every AI seat is played by the built-in bot. */
  ANTHROPIC_API_KEY?: string;
  /** Hard cap on Claude turns per game; the bot plays every turn after it. Defaults to 400. */
  CLAUDE_TURNS_PER_GAME?: string;
  /** Per-seat limit on press. */
  PRESS_LIMITER?: RateLimit;
  /** Per-IP limit on creating games. Optional so tests and local dev run without it. */
  CREATE_LIMITER?: RateLimit;
  /** Per-IP limit on joining games and issuing substitute invites. */
  JOIN_LIMITER?: RateLimit;
  /** Per-IP limit on reads, starts and socket upgrades: each one can wake a room. */
  READ_LIMITER?: RateLimit;
}

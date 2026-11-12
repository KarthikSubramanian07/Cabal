import type { GameRoom } from "./room.js";

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  /** Cross-game summary index. Optional in unit tests and local development. */
  DB?: D1Database;
  /** Agent turn queue: configure the corresponding Cloudflare Queue before deployment. */
  AGENT_QUEUE?: Queue<{ gameId: string; power: string; token: string }>;
  ANTHROPIC_API_KEY?: string;
  /** Per-IP limit on private and public press ingress. */
  PRESS_LIMITER?: RateLimit;
  /** Per-IP limit on creating games. Optional so tests and local dev run without it. */
  CREATE_LIMITER?: RateLimit;
  /** Per-IP limit on joining games. */
  JOIN_LIMITER?: RateLimit;
}

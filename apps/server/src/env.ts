import type { GameRoom } from "./room.js";

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  /** Per-IP limit on creating games. Optional so tests and local dev run without it. */
  CREATE_LIMITER?: RateLimit;
  /** Per-IP limit on joining games. */
  JOIN_LIMITER?: RateLimit;
}

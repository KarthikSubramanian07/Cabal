import type { GameRoom } from "./room.js";

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
}

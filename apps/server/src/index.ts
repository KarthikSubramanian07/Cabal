// Scaffold: the GameRoom Durable Object lands in the server PR.
import { DurableObject } from "cloudflare:workers";

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
}

export class GameRoom extends DurableObject<Env> {
  async health(): Promise<string> {
    return "ok";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const id = env.GAME_ROOM.idFromName("health");
      const stub = env.GAME_ROOM.get(id);
      return new Response(await stub.health());
    }
    return new Response("cabal-server scaffold", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

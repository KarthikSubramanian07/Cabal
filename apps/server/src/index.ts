/**
 * cabal-server: HTTP router in front of the GameRoom Durable Objects.
 *
 *   POST /api/games                 create a game, returns the creator's seat token
 *   POST /api/games/:id/join        claim a seat
 *   POST /api/games/:id/start       creator starts early (AI fills open seats)
 *   GET  /api/games/:id             public summary
 *   GET  /api/games/:id/replay      MILA saved game JSON
 *   GET  /api/games/:id/ws?token=   WebSocket (spectators may omit the token)
 *   GET  /health
 */
import { CreateGameRequest, JoinGameRequest } from "@cabal/protocol";
import type { Env } from "./env.js";
import { gameCode } from "./tokens.js";

export { GameRoom } from "./room.js";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers, webSocket: res.webSocket ?? null });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const GAME_PATH = /^\/api\/games\/([A-Z0-9]{6})(?:\/(join|start|replay|ws))?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/health") return withCors(json({ ok: true }));

    if (url.pathname === "/api/games" && request.method === "POST") {
      const body = CreateGameRequest.safeParse(await request.json().catch(() => ({})));
      if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
      const id = gameCode();
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id));
      const res = await stub.fetch("https://room/create", {
        method: "POST",
        body: JSON.stringify({ id, name: body.data.name, settings: body.data.settings }),
      });
      return withCors(res);
    }

    const m = GAME_PATH.exec(url.pathname);
    if (m) {
      const [, id, action] = m;
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id!));
      if (action === "ws") {
        return stub.fetch(`https://room/ws${url.search}`, request);
      }
      if (action === "join" && request.method === "POST") {
        const body = JoinGameRequest.safeParse(await request.json().catch(() => ({})));
        if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
        return withCors(await stub.fetch("https://room/join", { method: "POST", body: JSON.stringify(body.data) }));
      }
      if (action === "start" && request.method === "POST") {
        return withCors(
          await stub.fetch("https://room/start", { method: "POST", headers: { authorization: request.headers.get("authorization") ?? "" } }),
        );
      }
      if (action === "replay" && request.method === "GET") return withCors(await stub.fetch("https://room/replay"));
      if (!action && request.method === "GET") return withCors(await stub.fetch("https://room/summary"));
    }
    return withCors(json({ error: "not found" }, 404));
  },
} satisfies ExportedHandler<Env>;

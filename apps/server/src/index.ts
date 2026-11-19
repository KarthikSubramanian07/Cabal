/**
 * cabal-server: HTTP router in front of the GameRoom Durable Objects and the Registry.
 *
 *   POST /api/games                   create a game, returns the creator's seat token
 *   GET  /api/games                   recently finished and abandoned games (from the Registry)
 *   POST /api/games/:id/join          claim a lobby seat, or a vacated seat with a substitute invite
 *   POST /api/games/:id/start         creator starts early (AI fills open seats)
 *   POST /api/games/:id/substitute    a seated player opens a vacated seat to an invited substitute
 *   GET  /api/games/:id               public summary
 *   GET  /api/games/:id/replay        MILA saved game JSON
 *   GET  /api/games/:id/ledger        kept, broken and void pledges per power
 *   GET  /api/games/:id/ws            WebSocket; a player then sends `hello { token }`
 *   GET  /health
 *
 * The queue handler plays Claude turns for games that opted into them (see agent-consumer.ts).
 */
import { CreateGameRequest, GameResult, JoinGameRequest, SubstituteInviteRequest, resolveSettings } from "@cabal/protocol";
import { consumeTurns } from "./agent-consumer.js";
import type { AgentTurn, Env } from "./env.js";
import { REGISTRY_NAME } from "./registry.js";
import { gameCode } from "./tokens.js";

export { GameRoom } from "./room.js";
export { Registry } from "./registry.js";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

/** Request bodies are small JSON objects; anything larger is refused before parsing. */
const MAX_BODY_BYTES = 4096;

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  headers.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: res.status, headers, webSocket: res.webSocket ?? null });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const GAME_PATH = /^\/api\/games\/([A-Z0-9]{6})(?:\/(join|start|substitute|replay|ledger|ws))?$/;

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text || "{}");
  } catch {
    return undefined;
  }
}

/** True when the caller is over the limit. Missing bindings (tests, local dev) never limit. */
async function limited(limiter: RateLimit | undefined, request: Request, route: string): Promise<boolean> {
  if (!limiter) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${route}:${ip}` });
  return !success;
}

const tooMany = () => withCors(json({ error: "too many requests, try again in a minute" }, 429));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/health") return withCors(json({ ok: true }));

    if (url.pathname === "/api/games" && request.method === "POST") {
      if (await limited(env.CREATE_LIMITER, request, "create")) return tooMany();
      const body = CreateGameRequest.safeParse(await readJson(request));
      if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
      // Settings are validated and resolved here, so bad input is a 400 and never reaches a room.
      const settings = resolveSettings(body.data.settings);
      const id = gameCode();
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id));
      const res = await stub.fetch("https://room/create", {
        method: "POST",
        body: JSON.stringify({ id, name: body.data.name, settings }),
      });
      return withCors(res);
    }

    if (url.pathname === "/api/games" && request.method === "GET") {
      if (await limited(env.READ_LIMITER, request, "read")) return tooMany();
      if (!env.REGISTRY) return withCors(json({ games: [] }));
      const limit = Number(url.searchParams.get("limit") ?? "25");
      const before = Number(url.searchParams.get("before") ?? "");
      const result = GameResult.safeParse(url.searchParams.get("result"));
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME));
      const games = await registry.listGames({
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(Number.isFinite(before) && before > 0 ? { before } : {}),
        ...(result.success ? { result: result.data } : {}),
      });
      return withCors(json({ games }));
    }

    const m = GAME_PATH.exec(url.pathname);
    if (m) {
      const [, id, action] = m;
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id!));
      const authorization = { authorization: request.headers.get("authorization") ?? "" };
      if (action === "join" && request.method === "POST") {
        if (await limited(env.JOIN_LIMITER, request, "join")) return tooMany();
        const body = JoinGameRequest.safeParse(await readJson(request));
        if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
        return withCors(await stub.fetch("https://room/join", { method: "POST", headers: authorization, body: JSON.stringify(body.data) }));
      }
      if (action === "substitute" && request.method === "POST") {
        if (await limited(env.JOIN_LIMITER, request, "substitute")) return tooMany();
        const body = SubstituteInviteRequest.safeParse(await readJson(request));
        if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
        return withCors(await stub.fetch("https://room/substitute", { method: "POST", headers: authorization, body: JSON.stringify(body.data) }));
      }
      // Everything below can wake a room and load the engine, so it shares one per-address limit.
      if (await limited(env.READ_LIMITER, request, "read")) return tooMany();
      if (action === "ws") {
        // Seat tokens never travel in a URL; a stray query string is not forwarded.
        if (url.searchParams.has("token")) {
          return withCors(json({ error: "send the seat token in a hello frame, not in the URL" }, 400));
        }
        return stub.fetch("https://room/ws", request);
      }
      if (action === "start" && request.method === "POST") {
        return withCors(await stub.fetch("https://room/start", { method: "POST", headers: authorization }));
      }
      if (action === "replay" && request.method === "GET") return withCors(await stub.fetch("https://room/replay"));
      if (action === "ledger" && request.method === "GET") return withCors(await stub.fetch("https://room/ledger"));
      if (!action && request.method === "GET") return withCors(await stub.fetch("https://room/summary"));
    }
    return withCors(json({ error: "not found" }, 404));
  },
  async queue(batch: MessageBatch<AgentTurn>, env: Env): Promise<void> {
    await consumeTurns(batch, env);
  },
} satisfies ExportedHandler<Env, AgentTurn>;

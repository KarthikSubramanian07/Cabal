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
import { ClaudeBrain, FallbackBrain, PERSONAS, Player } from "@cabal/agents";
import { Game, mapInfo } from "@cabal/engine";
import type { PowerName, PressView, StateView } from "@cabal/protocol";
import { engineReady } from "./engine.js";
import type { Env } from "./env.js";
import { gameCode } from "./tokens.js";

export { GameRoom } from "./room.js";

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

const GAME_PATH = /^\/api\/games\/([A-Z0-9]{6})(?:\/(join|start|replay|ledger|ws))?$/;

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
      const rawBody = await readJson(request);
      const body = CreateGameRequest.safeParse(rawBody);
      if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
      const rawSettings = typeof rawBody === "object" && rawBody !== null && "settings" in rawBody ? rawBody.settings : {};
      const id = gameCode();
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id));
      const res = await stub.fetch("https://room/create", {
        method: "POST",
        body: JSON.stringify({ id, name: body.data.name, settings: rawSettings }),
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
        if (await limited(env.JOIN_LIMITER, request, "join")) return tooMany();
        const body = JoinGameRequest.safeParse(await readJson(request));
        if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
        return withCors(await stub.fetch("https://room/join", { method: "POST", body: JSON.stringify(body.data) }));
      }
      if (action === "start" && request.method === "POST") {
        return withCors(
          await stub.fetch("https://room/start", { method: "POST", headers: { authorization: request.headers.get("authorization") ?? "" } }),
        );
      }
      if (action === "replay" && request.method === "GET") return withCors(await stub.fetch("https://room/replay"));
      if (action === "ledger" && request.method === "GET") return withCors(await stub.fetch("https://room/ledger"));
      if (!action && request.method === "GET") return withCors(await stub.fetch("https://room/summary"));
    }
    return withCors(json({ error: "not found" }, 404));
  },
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await engineReady();
    for (const message of batch.messages) {
      const { gameId, power, token } = message.body as { gameId: string; power: PowerName; token: string };
      const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
      const brain = env.ANTHROPIC_API_KEY ? new ClaudeBrain({ apiKey: env.ANTHROPIC_API_KEY }) : new FallbackBrain();
      const player = new Player(power, PERSONAS[power] ?? "A careful strategist.", brain);
      try {
        const authorization = { authorization: `Bearer ${token}` };
        const stateResponse = await room.fetch("https://room/agent/state", { headers: authorization });
        if (stateResponse.status === 409) {
          message.ack();
          continue;
        }
        if (!stateResponse.ok) throw new Error(`agent state failed: ${stateResponse.status}`);
        const welcome = await stateResponse.json() as { phase: string; state: StateView; press: PressView[] };
        const game = Game.fromState(welcome.state);
        const { decision, validated } = await player.play({
          phase: welcome.phase,
          state: welcome.state,
          map: mapInfo(),
          legal: game.legal(power),
          press: welcome.press.map((item) => ({ from: item.from, to: item.to, body: item.body, pledge: item.pledge?.orders ?? null })),
          myPledges: welcome.press
            .filter((item) => item.phase === welcome.phase && item.from === power && item.pledge?.orders)
            .map((item) => item.pledge!.orders!),
          trust: {},
        });
        const knownPowers = new Set<PowerName>(["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"]);
        const frames: unknown[] = decision.messages
          .filter((item) => item.to === "ALL" || knownPowers.has(item.to as PowerName))
          .map((item) => {
            const pledgedOrders = decision.pledge?.to === item.to
              ? decision.pledge.orders.filter((order) => validated.orders.includes(order))
              : [];
            return {
              t: "press.send",
              p: {
                to: item.to,
                body: item.body,
                ...(pledgedOrders.length > 0 && decision.pledge
                  ? { pledge: { orders: pledgedOrders, sealed: decision.pledge.sealed } }
                  : {}),
              },
            };
          });
        frames.push(
          { t: "orders.set", p: { phase: welcome.phase, orders: validated.orders } },
          { t: "ready", p: { phase: welcome.phase, ready: true } },
        );
        const actionResponse = await room.fetch("https://room/agent/act", {
          method: "POST",
          headers: { ...authorization, "content-type": "application/json" },
          body: JSON.stringify({ frames }),
        });
        if (!actionResponse.ok) throw new Error(`agent action failed: ${actionResponse.status} ${await actionResponse.text()}`);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "agent_turn_failed", gameId, power, error: String(error) }));
        message.retry({ delaySeconds: 30 });
      }
    }
  },
} satisfies ExportedHandler<Env>;

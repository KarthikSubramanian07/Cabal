/**
 * cabal-server: HTTP router in front of the GameRoom Durable Objects and the Registry.
 *
 *   POST /api/games                   create a game, returns the creator's seat token
 *   GET  /api/games?status=           public games: `open` lobbies, `active` games, or `finished` ones (the default)
 *   POST /api/games/:id/join          claim a lobby seat, or a vacated seat with a substitute invite
 *   POST /api/games/:id/seat          a signed-in player's own seat token, again (another device)
 *   POST /api/games/:id/start         creator starts early (AI fills open seats)
 *   POST /api/games/:id/substitute    a seated player opens a vacated seat to an invited substitute
 *   GET  /api/games/:id               public summary
 *   GET  /api/games/:id/replay        MILA saved game JSON, plus the resolved pledges and receipts
 *   GET  /api/games/:id/ledger        pledge totals per power and every resolved pledge the caller may read
 *   GET  /api/games/:id/press         one page of press history (`before`, `with`, `limit`)
 *   GET  /api/games/:id/ws            WebSocket; a player then sends `hello { token }`
 *   GET  /health                      liveness, engine version, build id, index reachability (503 when the index is down or behind)
 *   GET  /api/push/key                the VAPID public key a browser subscribes with (null when push is off)
 *   POST /api/metrics                 anonymous timings from a browser; GET (admin) the phase 1 metrics
 *   POST /api/metrics/datc            admin: record the DATC totals for a commit
 *
 * Players, profiles, the leaderboard and the trust ledger are served by players.ts. A signed-in
 * player sends their player secret as the bearer on create and join; they then sit under their
 * handle, one seat per game, and the seat is theirs to recover on another device.
 *
 * Every response is JSON with CORS headers, including failures: an exception anywhere below is
 * caught at the top, logged as one structured line and answered with a 500 that names a request id.
 *
 * The queue handler plays Claude turns for games that opted into them (see agent-consumer.ts).
 */
import {
  CreateGameRequest,
  GameResult,
  type HealthResponse,
  JoinGameRequest,
  PROTOCOL_VERSION,
  SubstituteInviteRequest,
  resolveSettings,
} from "@cabal/protocol";
import { consumeTurns } from "./agent-consumer.js";
import { engineReady, version as engineVersion } from "./engine.js";
import type { AgentTurn, Env } from "./env.js";
import { D1_SCHEMA_REQUIRED, copyRegistryOnce, gameIndex, indexBackend, registrySchema } from "./game-index.js";
import { REQUEST_ID_HEADER, currentRequestId, describeError, log, requestIdFrom, withLogContext } from "./log.js";
import { gameCode, isPlayerSecret } from "./tokens.js";
import { CORS, json, limited, readJson, tooMany, withCors } from "./http.js";
import { metricsRoute } from "./metrics.js";
import { reportsRoute } from "./moderation.js";
import { vapidKeys } from "./notify.js";
import { bearerOf, playerRoute, resolvePlayer } from "./players.js";

export { GameRoom } from "./room.js";
export { Registry } from "./registry.js";

const GAME_PATH = /^\/api\/games\/([A-Z0-9]{6})(?:\/(join|seat|start|substitute|replay|ledger|press|ws))?$/;

/** A request to a room, carrying the current request id so the room's log lines share it. */
function roomFetch(stub: { fetch(request: Request): Promise<Response> }, path: string, init: RequestInit | Request = {}): Promise<Response> {
  const request = new Request(`https://room${path}`, init);
  const id = currentRequestId();
  if (id) request.headers.set(REQUEST_ID_HEADER, id);
  return stub.fetch(request);
}

const signedOut = () => withCors(json({ error: "that player secret is not valid; sign in again or play without it", code: "signed_out" }, 401));

/** How long `/health` waits for the index before calling it unreachable. */
const HEALTH_TIMEOUT_MS = 2000;

/** The deployed build: set `BUILD_ID` at deploy time, else the Worker version id, else `dev`. */
export function buildId(env: Env): string {
  return env.BUILD_ID || env.CF_VERSION_METADATA?.id || "dev";
}

/** `/health` asks the index at most this often per isolate; in between it answers from memory. */
const HEALTH_CACHE_MS = 5000;
let probed: { at: number; index: number | null; registry: number | null; stores: [unknown, unknown] } | null = null;

/** A probe that gives up after `HEALTH_TIMEOUT_MS`: null when unreachable, logged as such. */
async function probe(what: string, ask: () => Promise<number | null>): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ask(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), HEALTH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    log("health_index_unreachable", { store: what, ...describeError(error) }, "error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function health(env: Env): Promise<HealthResponse> {
  await engineReady();
  const backend = indexBackend(env);
  const fresh = probed !== null && probed.stores[0] === env.DB && probed.stores[1] === env.REGISTRY && Date.now() - probed.at < HEALTH_CACHE_MS;
  if (!fresh) {
    const index = gameIndex(env);
    const [indexSchema, registry] = await Promise.all([
      index ? probe(backend, () => index.schemaVersion()) : Promise.resolve(null),
      env.REGISTRY ? probe("registry", () => registrySchema(env)) : Promise.resolve(null),
    ]);
    probed = { at: Date.now(), index: indexSchema, registry, stores: [env.DB, env.REGISTRY] };
  }
  // The index is what every game and account needs: unreachable, or a D1 schema behind this build,
  // and the deployment is not healthy. The Registry only keeps the Claude budget.
  const indexOk = backend === "none" || (probed!.index !== null && (backend !== "d1" || probed!.index >= D1_SCHEMA_REQUIRED));
  return {
    ok: indexOk,
    protocol: PROTOCOL_VERSION,
    engine: engineVersion(),
    build: buildId(env),
    registry: { reachable: probed!.registry !== null, schema: probed!.registry },
    index: { backend, reachable: probed!.index !== null, schema: probed!.index },
    time: Date.now(),
  };
}

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);

  // `/api/health` is the same answer where only `/api` reaches the server (the web app's status page).
  if (url.pathname === "/health" || url.pathname === "/api/health") {
    // Unauthenticated and it reaches the one index object, so it is limited like any other read.
    if (await limited(env.READ_LIMITER, request, "read")) return tooMany();
    const report = await health(env);
    return withCors(json(report, report.ok ? 200 : 503));
  }

  if (url.pathname === "/api/push/key" && request.method === "GET") {
    const res = json({ publicKey: vapidKeys(env)?.publicKey ?? null });
    res.headers.set("cache-control", "public, max-age=300");
    return withCors(res);
  }

  const metrics = await metricsRoute(request, env, url);
  if (metrics) return metrics;

  const reports = await reportsRoute(request, env, url);

  if (reports) return reports;

  const players = await playerRoute(request, env, url);
  if (players) return players;

  if (url.pathname === "/api/games" && request.method === "POST") {
    if (await limited(env.CREATE_LIMITER, request, "create")) return tooMany();
    const who = await resolvePlayer(request, env);
    if (who === "invalid") return signedOut();
    const body = CreateGameRequest.safeParse(await readJson(request));
    if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
    const player = who === "none" ? undefined : { id: who.player.id, handle: who.player.handle };
    if (!player && !body.data.name) return withCors(json({ error: "a name is required to play without signing in" }, 400));
    // Settings are validated and resolved here, so bad input is a 400 and never reaches a room.
    const settings = resolveSettings(body.data.settings);
    const id = gameCode();
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id));
    const res = await roomFetch(stub, "/create", {
      method: "POST",
      body: JSON.stringify({ id, name: body.data.name, settings, player }),
    });
    return withCors(res);
  }

  if (url.pathname === "/api/games" && request.method === "GET") {
    if (await limited(env.READ_LIMITER, request, "read")) return tooMany();
    const index = gameIndex(env);
    if (!index) return withCors(json({ games: [] }));
    const status = url.searchParams.get("status") ?? "finished";
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const before = Number(url.searchParams.get("before") ?? "");
    const page = {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(before) && before > 0 ? { before } : {}),
    };
    if (status === "open" || status === "active") {
      return withCors(json({ status, games: await index.listListings({ status, now: Date.now(), ...page }) }));
    }
    if (status !== "finished") return withCors(json({ error: "status must be open, active or finished" }, 400));
    const result = GameResult.safeParse(url.searchParams.get("result"));
    return withCors(json({ status, games: await index.listGames({ ...page, ...(result.success ? { result: result.data } : {}) }) }));
  }

  const m = GAME_PATH.exec(url.pathname);
  if (m) {
    const [, id, action] = m;
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id!));
    // A room only ever reads seat tokens; a player secret sent here by mistake goes no further.
    const authorization = { authorization: isPlayerSecret(bearerOf(request)) ? "" : (request.headers.get("authorization") ?? "") };
    if (action === "join" && request.method === "POST") {
      if (await limited(env.JOIN_LIMITER, request, "join")) return tooMany();
      const who = await resolvePlayer(request, env);
      if (who === "invalid") return signedOut();
      const body = JoinGameRequest.safeParse(await readJson(request));
      if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
      const player = who === "none" ? undefined : { id: who.player.id, handle: who.player.handle };
      if (!player && !body.data.name) return withCors(json({ error: "a name is required to play without signing in" }, 400));
      // The room is told who the player is in the body; a player secret is never handed to a room
      // (nor is one forwarded on the other routes: `authorization` drops it).
      const headers = player ? {} : authorization;
      return withCors(await roomFetch(stub, "/join", { method: "POST", headers, body: JSON.stringify({ ...body.data, player }) }));
    }
    if (action === "seat" && request.method === "POST") {
      if (await limited(env.JOIN_LIMITER, request, "seat")) return tooMany();
      const who = await resolvePlayer(request, env);
      if (who === "invalid" || who === "none") return signedOut();
      return withCors(await roomFetch(stub, "/seat", { method: "POST", body: JSON.stringify({ player: { id: who.player.id, handle: who.player.handle } }) }));
    }
    if (action === "substitute" && request.method === "POST") {
      if (await limited(env.JOIN_LIMITER, request, "substitute")) return tooMany();
      const body = SubstituteInviteRequest.safeParse(await readJson(request));
      if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
      return withCors(await roomFetch(stub, "/substitute", { method: "POST", headers: authorization, body: JSON.stringify(body.data) }));
    }
    // Everything below can wake a room and load the engine, so it shares one per-address limit.
    if (await limited(env.READ_LIMITER, request, "read")) return tooMany();
    if (action === "ws") {
      // Seat tokens never travel in a URL; a stray query string is not forwarded.
      if (url.searchParams.has("token")) {
        return withCors(json({ error: "send the seat token in a hello frame, not in the URL" }, 400));
      }
      return roomFetch(stub, "/ws", request);
    }
    if (action === "start" && request.method === "POST") {
      return withCors(await roomFetch(stub, "/start", { method: "POST", headers: authorization }));
    }
    // Reads that depend on who is asking take the seat token as a bearer header, never in the URL.
    if (action === "replay" && request.method === "GET") return withCors(await roomFetch(stub, "/replay", { headers: authorization }));
    if (action === "ledger" && request.method === "GET") return withCors(await roomFetch(stub, "/ledger", { headers: authorization }));
    if (action === "press" && request.method === "GET") {
      if (url.searchParams.has("token")) return withCors(json({ error: "send the seat token as a bearer header, not in the URL" }, 400));
      return withCors(await roomFetch(stub, `/press${url.search}`, { headers: authorization }));
    }
    if (!action && request.method === "GET") return withCors(await roomFetch(stub, "/summary"));
  }
  return withCors(json({ error: "not found" }, 404));
}

/** The route as a label, never the raw path: game codes are not secret, but logs should group. */
function routeLabel(request: Request): string {
  const path = new URL(request.url).pathname.replace(/\/[A-Z0-9]{6}(?=\/|$)/, "/:id");
  return `${request.method} ${path.slice(0, 64)}`;
}

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    // Cloudflare's ray id names the request in its own dashboards too; locally a fresh id stands in.
    const requestId = requestIdFrom(request.headers.get("cf-ray"));
    return withLogContext({ service: "worker", requestId }, () => serve(request, env, ctx, requestId));
  },
  queue(batch: MessageBatch<AgentTurn>, env: Env): Promise<void> {
    return withLogContext({ service: "queue", requestId: requestIdFrom(null, "q") }, async () => {
      try {
        await consumeTurns(batch, env);
      } catch (error) {
        // Rethrown so the queue retries the batch; logged so the failure has a name.
        log("queue_failed", { queue: batch.queue, messages: batch.messages.length, ...describeError(error) }, "error");
        throw error;
      }
    });
  },
} satisfies ExportedHandler<Env, AgentTurn>;

async function serve(request: Request, env: Env, ctx: ExecutionContext | undefined, requestId: string): Promise<Response> {
  const started = Date.now();
  let res: Response;
  try {
    // The games index moved from the Registry to D1: its rows are copied across once, in the background.
    const copy = copyRegistryOnce(env);
    if (copy && ctx) ctx.waitUntil(copy.catch((error) => log("registry_copy_failed", describeError(error), "error")));
    res = await route(request, env);
  } catch (error) {
    // The error boundary: whatever broke, the caller gets JSON with CORS and the log gets one line.
    log("unhandled_error", { route: routeLabel(request), build: buildId(env), ...describeError(error) }, "error");
    if (request.headers.get("upgrade") === "websocket") return new Response(null, { status: 500 });
    res = withCors(json({ error: "internal error", requestId }, 500));
  }
  // One access line per request: the route as a label, never a path with a code or a query in it.
  log("request", { route: routeLabel(request), status: res.status, ms: Date.now() - started });
  // A socket upgrade is answered as the room made it; every other answer names its request.
  if (res.status === 101 || res.webSocket) return res;
  const named = new Response(res.body, res);
  named.headers.set(REQUEST_ID_HEADER, requestId);
  return named;
}

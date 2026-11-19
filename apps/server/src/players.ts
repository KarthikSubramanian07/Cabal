/**
 * Player routes: guest accounts, the signed-in player's own pages, public profiles and boards.
 *
 *   POST  /api/players            make a guest account on this device; the secret is shown once
 *   POST  /api/players/recover    restore an account on a new device from its recovery code
 *   GET   /api/players/:handle    public profile: rating, rank, reliability, the ledger, recent results
 *   GET   /api/me                 the signed-in player's profile and account
 *   PATCH /api/me                 change handle (once freely, then once every 14 days)
 *   POST  /api/me/recovery        a new recovery code, shown once; the old one stops working
 *   POST  /api/me/logout          end this device's session (or every one)
 *   GET   /api/me/games           the player's own games, live and ended, listed or not
 *   GET   /api/leaderboard        established ratings, best first, paged by `offset`
 *   GET   /api/ledger             the global trust ledger, paged by `offset`
 *
 * A player authenticates with `Authorization: Bearer <secret>`. Secrets never travel in a URL and
 * only their hashes are stored. Without a D1 database these routes answer 503.
 */
import {
  CreatePlayerRequest,
  LogoutRequest,
  type PlayerSummary,
  RecoverPlayerRequest,
  UpdateMeRequest,
} from "@cabal/protocol";
import type { PlayerStore, RenameOutcome } from "./d1-index.js";
import type { Env } from "./env.js";
import { playerStore } from "./game-index.js";
import { json, limited, limitedKey, readJson, tooMany, withCors } from "./http.js";
import { isPlayerSecret } from "./tokens.js";

const PLAYER_PATH = /^\/api\/players\/([A-Za-z0-9_-]{1,32})$/;

export const bearerOf = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";

/** Answers for the public, cacheable reads; the private ones are never stored anywhere. */
const publicJson = (data: unknown, seconds: number) => {
  const res = json(data);
  res.headers.set("cache-control", `public, max-age=${seconds}`);
  return res;
};
const privateJson = (data: unknown, status = 200) => {
  const res = json(data, status);
  res.headers.set("cache-control", "private, no-store");
  return res;
};

const unauthorised = () => withCors(json({ error: "sign in: send your player secret as a bearer token", code: "signed_out" }, 401));
const refused = (outcome: Exclude<RenameOutcome, { ok: true }>) =>
  withCors(json({ error: outcome.message, code: outcome.code, ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}) }, outcome.status));

/**
 * The signed-in player behind a request. `none`: no player secret was sent. `invalid`: one was
 * sent and it is not (or no longer) valid, which a caller must never treat as anonymous.
 */
export async function resolvePlayer(request: Request, env: Env): Promise<{ player: PlayerSummary } | "none" | "invalid"> {
  const bearer = bearerOf(request);
  if (!isPlayerSecret(bearer)) return "none";
  const store = playerStore(env);
  if (!store) return "invalid";
  const player = await store.authenticate(bearer, Date.now());
  return player ? { player } : "invalid";
}

const page = (url: URL) => ({
  offset: Number(url.searchParams.get("offset") ?? "0") || 0,
  limit: Number(url.searchParams.get("limit") ?? "25") || 25,
});

/** Serve a player route, or return null when the path is not one. */
export async function playerRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const isPlayers = path === "/api/players" || path.startsWith("/api/players/") || path === "/api/me" || path.startsWith("/api/me/");
  if (!isPlayers && path !== "/api/leaderboard" && path !== "/api/ledger") return null;
  const store = playerStore(env);
  if (!store) return withCors(json({ error: "players are not available on this deployment" }, 503));
  const now = Date.now();

  if (path === "/api/players" && request.method === "POST") {
    if (await limited(env.ACCOUNT_LIMITER, request, "account")) return tooMany();
    const body = CreatePlayerRequest.safeParse(await readJson(request));
    if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
    const made = await store.createPlayer(body.data.handle ?? null, now);
    if ("ok" in made) return refused(made as Exclude<RenameOutcome, { ok: true }>);
    return withCors(privateJson(made, 201));
  }

  if (path === "/api/players/recover" && request.method === "POST") {
    // Guessing a 100-bit code is hopeless, and the limit keeps it that way.
    if (await limited(env.ACCOUNT_LIMITER, request, "recover")) return tooMany();
    const body = RecoverPlayerRequest.safeParse(await readJson(request));
    if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
    const session = await store.recover(body.data.code, now);
    if (!session) return withCors(json({ error: "that recovery code is not valid", code: "bad_recovery_code" }, 401));
    return withCors(privateJson(session));
  }

  if (request.method === "GET" && (path === "/api/leaderboard" || path === "/api/ledger" || PLAYER_PATH.test(path))) {
    if (await limited(env.READ_LIMITER, request, "read")) return tooMany();
    if (path === "/api/leaderboard") return withCors(publicJson(await store.leaderboard({ ...page(url), now }), 60));
    if (path === "/api/ledger") return withCors(publicJson(await store.trustBoard(page(url)), 60));
    const handle = PLAYER_PATH.exec(path)![1]!;
    const profile = await store.profile(handle, now);
    if (!profile) return withCors(json({ error: "no such player" }, 404));
    return withCors(publicJson(profile, 30));
  }

  if (path === "/api/me" || path.startsWith("/api/me/")) {
    if (request.method === "GET" && (await limited(env.READ_LIMITER, request, "read"))) return tooMany();
    const bearer = bearerOf(request);
    const player = isPlayerSecret(bearer) ? await store.authenticate(bearer, now) : null;
    if (!player) return unauthorised();
    if (request.method !== "GET" && (await limitedKey(env.PROFILE_LIMITER, `profile:${player.id}`))) return tooMany();
    return withCors(await me(request, store, player, bearer, path, now));
  }
  return withCors(json({ error: "not found" }, 404));
}

async function me(request: Request, store: PlayerStore, player: PlayerSummary, bearer: string, path: string, now: number): Promise<Response> {
  if (path === "/api/me" && request.method === "GET") return privateJson(await store.me(player.id, now));
  if (path === "/api/me" && request.method === "PATCH") {
    const body = UpdateMeRequest.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid request", issues: body.error.issues }, 400);
    const outcome = await store.rename(player.id, body.data.handle, now);
    if (!outcome.ok) return refused(outcome);
    return privateJson(await store.me(player.id, now));
  }
  if (path === "/api/me/recovery" && request.method === "POST") return privateJson(await store.issueRecoveryCode(player.id, now));
  if (path === "/api/me/logout" && request.method === "POST") {
    const body = LogoutRequest.safeParse((await readJson(request)) ?? {});
    await store.logout(bearer, body.success ? body.data.everywhere : false);
    return new Response(null, { status: 204 });
  }
  if (path === "/api/me/games" && request.method === "GET") return privateJson({ games: await store.myGames(player.id) });
  return json({ error: "not found" }, 404);
}

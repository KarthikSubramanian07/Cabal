/**
 * Player routes: guest accounts, the signed-in player's own pages, public profiles and boards.
 *
 *   POST  /api/players            make a guest account on this device; the secret is shown once
 *   POST  /api/players/recover    restore an account on a new device from its recovery code
 *   GET   /api/auth/google        the Google client ID the sign-in button needs, or null when off
 *   POST  /api/auth/google        sign in with Google: open, link or make the account (google.ts)
 *   GET   /api/players/:handle    public profile: rating, rank, reliability, the ledger, recent results
 *   GET   /api/players/:handle/ratings  the rating after each rated game, oldest first (`limit`)
 *   POST  /api/players/:handle/report   signed in: report a player to the maintainers (moderation.ts)
 *   GET   /api/me                 the signed-in player's profile and account
 *   PATCH /api/me                 change handle (once freely, then once every 14 days)
 *   DELETE /api/me                delete the account for good (`{ handle }` to confirm); seats become ghosts
 *   POST  /api/me/recovery        a new recovery code, shown once; the old one stops working
 *   POST  /api/me/logout          end this device's session (or every one)
 *   DELETE /api/me/google         unlink the Google account; the recovery code still works
 *   GET   /api/me/sync            the settings and sandbox game that follow the player between devices
 *   PATCH /api/me/sync            a device's newer settings or sandbox game (the latest write wins)
 *   GET   /api/me/games           the player's own games, live and ended, listed or not
 *   GET   /api/leaderboard        established ratings, best first, paged by `offset`
 *   GET   /api/ledger             the global trust ledger, paged by `offset`
 *   POST  /api/me/push            subscribe this browser to push (a `PushSubscription.toJSON()`)
 *   DELETE /api/me/push           forget one browser's subscription
 *   GET   /api/me/notifications   which notices the player wants, and how many devices hear them
 *   PATCH /api/me/notifications   turn kinds of notice on or off
 *
 * A player authenticates with `Authorization: Bearer <secret>`. Secrets never travel in a URL and
 * only their hashes are stored. Without a D1 database these routes answer 503.
 */
import {
  CreatePlayerRequest,
  DeleteMeRequest,
  GoogleSignInRequest,
  type DeleteMeResponse,
  LogoutRequest,
  PlayerReportRequest,
  type NotificationsResponse,
  type PlayerSummary,
  PushSubscriptionRequest,
  PushUnsubscribeRequest,
  RecoverPlayerRequest,
  SANDBOX_SYNC_MAX,
  SyncRequest,
  UpdateMeRequest,
  UpdateNotificationPreferences,
} from "@cabal/protocol";
import type { PlayerStore, RenameOutcome } from "./d1-index.js";
import type { Env } from "./env.js";
import type { ForsakeAnswer } from "./room.js";
import { playerStore } from "./game-index.js";
import { json, limited, limitedKey, readJson, tooMany, withCors } from "./http.js";
import { reminderMinutes } from "./notify.js";
import { pushStore, subscriptionProblem } from "./push-store.js";
import { isPlayerSecret } from "./tokens.js";
import { handleKey } from "./handles.js";
import { fileReport, noteAccountOrigin } from "./moderation.js";
import { googleSubjectKey, verifyGoogleIdToken } from "./google.js";
import { REQUEST_ID_HEADER, currentRequestId, describeError, log } from "./log.js";

const PLAYER_PATH = /^\/api\/players\/([A-Za-z0-9_-]{1,32})$/;
const RATINGS_PATH = /^\/api\/players\/([A-Za-z0-9_-]{1,32})\/ratings$/;
const REPORT_PATH = /^\/api\/players\/([A-Za-z0-9_-]{1,32})\/report$/;
/** Rooms told about a deletion at once; a player rarely holds more seats than this in all. */
const FORSAKE_CONCURRENCY = 8;
/** A sync body: a sandbox game at its longest, its JSON escaping, and room for the rest. */
const SYNC_BODY_MAX = SANDBOX_SYNC_MAX * 2 + 4096;

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
  const isPlayers =
    path === "/api/players" || path.startsWith("/api/players/") || path === "/api/me" || path.startsWith("/api/me/") || path === "/api/auth/google";
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
    await noteAccountOrigin(env, request, made.player.id, now);
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

  if (path === "/api/auth/google") {
    const clientId = env.GOOGLE_CLIENT_ID?.trim() || null;
    if (request.method === "GET") return withCors(publicJson({ clientId }, 300));
    if (request.method !== "POST") return withCors(json({ error: "not found" }, 404));
    if (!clientId) return withCors(json({ error: "Google sign-in is not set up on this deployment", code: "google_off" }, 503));
    if (await limited(env.ACCOUNT_LIMITER, request, "google")) return tooMany();
    const body = GoogleSignInRequest.safeParse(await readJson(request));
    if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
    // Sent with this device's secret, the Google account is linked to the account it holds.
    const who = await resolvePlayer(request, env);
    if (who === "invalid") return unauthorised();
    let checked: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
    try {
      checked = await verifyGoogleIdToken(body.data.credential, clientId, now);
    } catch (error) {
      log("google_keys_failed", describeError(error), "error");
      return withCors(json({ error: "Google could not be reached; try again", code: "google_unreachable" }, 503));
    }
    if (!checked.ok) {
      log("google_refused", { reason: checked.reason });
      return withCors(json({ error: "Google did not vouch for that sign-in; try again", code: "google_refused" }, 401));
    }
    const result = await store.googleSession(googleSubjectKey(checked.subject), who === "none" ? null : who.player.id, now);
    if (result === "taken") {
      return withCors(json({ error: "this account is already linked to another Google account", code: "google_taken" }, 409));
    }
    if (result.outcome === "created") await noteAccountOrigin(env, request, result.session.player.id, now);
    return withCors(privateJson({ ...result.session, outcome: result.outcome }, result.outcome === "created" ? 201 : 200));
  }

  const reporting = REPORT_PATH.exec(path);
  if (reporting && request.method === "POST") return withCors(await report(request, env, store, reporting[1]!, now));

  if (request.method === "GET" && (path === "/api/leaderboard" || path === "/api/ledger" || PLAYER_PATH.test(path) || RATINGS_PATH.test(path))) {
    if (await limited(env.READ_LIMITER, request, "read")) return tooMany();
    if (path === "/api/leaderboard") return withCors(publicJson(await store.leaderboard({ ...page(url), now }), 60));
    if (path === "/api/ledger") return withCors(publicJson(await store.trustBoard(page(url)), 60));
    const ratings = RATINGS_PATH.exec(path);
    if (ratings) {
      const limit = Number(url.searchParams.get("limit") ?? "");
      const history = await store.ratingHistory(ratings[1]!, now, Number.isFinite(limit) && limit > 0 ? limit : undefined);
      if (!history) return withCors(json({ error: "no such player" }, 404));
      return withCors(publicJson(history, 30));
    }
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
    return withCors(await me(request, env, store, player, bearer, path, now));
  }
  return withCors(json({ error: "not found" }, 404));
}

async function me(request: Request, env: Env, store: PlayerStore, player: PlayerSummary, bearer: string, path: string, now: number): Promise<Response> {
  if (path === "/api/me" && request.method === "GET") return privateJson(await store.me(player.id, now));
  if (path === "/api/me" && request.method === "PATCH") {
    const body = UpdateMeRequest.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid request", issues: body.error.issues }, 400);
    const outcome = await store.rename(player.id, body.data.handle, now);
    if (!outcome.ok) return refused(outcome);
    return privateJson(await store.me(player.id, now));
  }
  if (path === "/api/me" && request.method === "DELETE") return deleteAccount(request, env, store, player);
  if (path === "/api/me/recovery" && request.method === "POST") return privateJson(await store.issueRecoveryCode(player.id, now));
  if (path === "/api/me/logout" && request.method === "POST") {
    const body = LogoutRequest.safeParse((await readJson(request)) ?? {});
    await store.logout(bearer, body.success ? body.data.everywhere : false);
    return new Response(null, { status: 204 });
  }
  if (path === "/api/me/google" && request.method === "DELETE") {
    await store.unlinkGoogle(player.id);
    return privateJson(await store.me(player.id, now));
  }
  if (path === "/api/me/sync" && request.method === "GET") return privateJson(await store.sync(player.id));
  if (path === "/api/me/sync" && request.method === "PATCH") {
    // A sandbox game is the one body here larger than a few kilobytes.
    const body = SyncRequest.safeParse(await readJson(request, SYNC_BODY_MAX));
    if (!body.success) return json({ error: "invalid request", issues: body.error.issues }, 400);
    return privateJson(await store.pushSync(player.id, body.data));
  }
  if (path === "/api/me/games" && request.method === "GET") return privateJson({ games: await store.myGames(player.id) });
  if (path === "/api/me/push" || path === "/api/me/notifications") return notifications(request, env, player, bearer, path, now);
  return json({ error: "not found" }, 404);
}

/** The player's push subscriptions and notification switches. */
async function notifications(request: Request, env: Env, player: PlayerSummary, bearer: string, path: string, now: number): Promise<Response> {
  const push = pushStore(env)!;
  const answer = async (status = 200) =>
    privateJson({ preferences: await push.preferences(player.id), devices: await push.devices(player.id), reminderMinutes: reminderMinutes(env) } satisfies NotificationsResponse, status);
  if (path === "/api/me/push" && request.method === "POST") {
    const body = PushSubscriptionRequest.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid request", issues: body.error.issues }, 400);
    const problem = subscriptionProblem(body.data);
    if (problem === "endpoint") return json({ error: "that endpoint is not a push service this server sends to", code: "bad_endpoint" }, 400);
    if (problem === "keys") return json({ error: "the subscription keys are not a P-256 key and a 16-byte secret", code: "bad_keys" }, 400);
    return privateJson({ devices: await push.subscribe(player.id, bearer, body.data, now) }, 201);
  }
  if (path === "/api/me/push" && request.method === "DELETE") {
    const body = PushUnsubscribeRequest.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid request", issues: body.error.issues }, 400);
    await push.unsubscribe(player.id, body.data.endpoint);
    return new Response(null, { status: 204 });
  }
  if (path === "/api/me/notifications" && request.method === "GET") return answer();
  if (path === "/api/me/notifications" && request.method === "PATCH") {
    const body = UpdateNotificationPreferences.safeParse(await readJson(request));
    if (!body.success) return json({ error: "invalid request", issues: body.error.issues }, 400);
    await push.setPreferences(player.id, body.data, now);
    return answer();
  }
  return json({ error: "not found" }, 404);
}

/**
 * Delete the signed-in player's account for good. The body must name the account's handle (as it
 * reads now: any case, `_` for `-`), so a replayed or mistaken request cannot delete anyone.
 *
 * Every room the player holds or held a seat in is told first, so their seats become ghosts by the
 * game's own rules and their name leaves each game; then the index forgets them (d1-index.ts
 * `deletePlayer`). A room that cannot be reached is no reason to keep the account: its seat is
 * anonymised when that game is next recorded, because the index no longer knows the id.
 */
async function deleteAccount(request: Request, env: Env, store: PlayerStore, player: PlayerSummary): Promise<Response> {
  const body = DeleteMeRequest.safeParse(await readJson(request));
  if (!body.success) return json({ error: "invalid request", issues: body.error.issues }, 400);
  if (handleKey(body.data.handle) !== handleKey(player.handle)) {
    return json({ error: "type the account's handle to delete it", code: "handle_mismatch" }, 400);
  }
  const games = await store.gamesOf(player.id);
  let unreached = 0;
  const unplayed: string[] = [];
  for (let i = 0; i < games.length; i += FORSAKE_CONCURRENCY) {
    const told = await Promise.allSettled(
      games.slice(i, i + FORSAKE_CONCURRENCY).map(async (gameId) => {
        const forsake = new Request("https://room/forsake", { method: "POST", body: JSON.stringify({ playerId: player.id }) });
        const id = currentRequestId();
        if (id) forsake.headers.set(REQUEST_ID_HEADER, id);
        const res = await env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId)).fetch(forsake);
        // A game the room never stored (it was created and forgotten) has nothing to forget either.
        if (!res.ok && res.status !== 404) throw new Error(`room answered ${res.status}`);
        if (res.ok && ((await res.json()) as Partial<ForsakeAnswer>).unplayed === true) unplayed.push(gameId);
      }),
    );
    for (const t of told) {
      if (t.status === "rejected") {
        unreached += 1;
        log("account_delete_room_unreached", describeError(t.reason), "error");
      }
    }
  }
  await store.deletePlayer(player.id, unplayed);
  log("account_deleted", { games: games.length, unreached });
  return privateJson({ deleted: true, games: games.length, unreached } satisfies DeleteMeResponse);
}

/** Report a player to the maintainers: signed in, never about oneself, once a day per player. */
async function report(request: Request, env: Env, store: PlayerStore, handle: string, now: number): Promise<Response> {
  // Per address first: a bad or forged bearer still costs a database read to turn away.
  if (await limited(env.PROFILE_LIMITER, request, "report")) return tooMany();
  const resolved = await resolvePlayer(request, env);
  if (resolved === "none" || resolved === "invalid") return json({ error: "sign in to report a player", code: "signed_out" }, 401);
  const reporter = resolved.player;
  if (await limitedKey(env.PROFILE_LIMITER, `report:${reporter.id}`)) return tooMany();
  const body = PlayerReportRequest.safeParse(await readJson(request));
  if (!body.success) return json({ error: "invalid request", issues: body.error.issues }, 400);
  if (!env.DB) return json({ error: "reports need the D1 database" }, 503);
  const subject = await store.profile(handle, now);
  if (!subject) return json({ error: "no such player" }, 404);
  const outcome = await fileReport(env.DB, reporter.id, subject.player.id, body.data, now);
  if (outcome === "self") return json({ error: "you cannot report yourself", code: "self_report" }, 400);
  return privateJson({ received: true }, 202);
}

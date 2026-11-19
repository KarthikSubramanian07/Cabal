/**
 * A stand-in game server for the end-to-end suite: `/api` answered from recorded responses
 * (fixtures/records, captured from a local `wrangler dev` after real rated games) and from small
 * handlers, so the front door, the account, the records and the replay are tested without a
 * server. The live suite (e2e-live) plays the same pages against the real one.
 */
import { readFileSync } from "node:fs";
import type { Page, Request, Route } from "@playwright/test";

const here = (p: string) => new URL(p, import.meta.url);
export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(here(`./fixtures/records/${name}.json`), "utf8")) as T;

export type Handler = (request: Request, match: RegExpExecArray) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

export interface FakeServer {
  /** Every API call seen, as `METHOD /path`. */
  calls: string[];
  on(method: string, path: RegExp, handler: Handler): void;
}

export async function fakeServer(page: Page): Promise<FakeServer> {
  const routes: { method: string; path: RegExp; handler: Handler }[] = [];
  const calls: string[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push(`${request.method()} ${url.pathname}${url.search}`);
    // The newest handler for a path wins, so a test can replace a default.
    for (const r of [...routes].reverse()) {
      const m = r.path.exec(url.pathname);
      if (m && r.method === request.method()) {
        const { status = 200, body = null } = await r.handler(request, m);
        return route.fulfill({ status, contentType: "application/json", body: body === null ? "" : JSON.stringify(body) });
      }
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  });
  return { calls, on: (method, path, handler) => void routes.push({ method, path, handler }) };
}

const PLAYER = { id: "pl_test_ada", handle: "ada_l", createdAt: Date.UTC(2026, 10, 1) };
export const SECRET = "ps_" + "a".repeat(40);

/** A profile with no games yet, as the server answers for a new account. */
export function freshProfile(handle = PLAYER.handle) {
  return {
    player: { ...PLAYER, handle },
    rating: null,
    reliability: { score: 0.9, phasesDue: 0, phasesOnTime: 0, phasesLate: 0, missed: 0, gamesCompleted: 0, gamesWalkedOut: 0 },
    trust: { score: 0.5, kept: 0, broken: 0, void: 0 },
    games: { played: 0, solos: 0, draws: 0 },
    recent: [],
  };
}

/** The account routes: make a guest, restore one, read and rename it, issue a recovery code, sign out. */
export function accountRoutes(server: FakeServer, opts: { taken?: string[] } = {}) {
  const state = { handle: PLAYER.handle, recoveryIssuedAt: null as number | null, renameAvailableAt: null as number | null, signedOut: false };
  const me = () => ({
    ...freshProfile(state.handle),
    account: { renameAvailableAt: state.renameAvailableAt, recoveryIssuedAt: state.recoveryIssuedAt, sessions: 1 },
  });
  server.on("POST", /^\/api\/players$/, (request) => {
    const body = (request.postDataJSON() ?? {}) as { handle?: string };
    if (body.handle && opts.taken?.includes(body.handle.toLowerCase())) return { status: 409, body: { error: "that handle is taken", code: "handle_taken" } };
    state.handle = body.handle ?? "quiet_otter";
    return { status: 201, body: { player: { ...PLAYER, handle: state.handle }, secret: SECRET } };
  });
  server.on("POST", /^\/api\/players\/recover$/, (request) => {
    const body = request.postDataJSON() as { code: string };
    if (!body.code.toUpperCase().startsWith("CABAL")) return { status: 401, body: { error: "that recovery code is not valid", code: "bad_recovery_code" } };
    state.handle = "restored_one";
    // Another account than the one a signed-in device holds.
    return { body: { player: { ...PLAYER, id: "pl_test_restored", handle: state.handle }, secret: SECRET } };
  });
  server.on("GET", /^\/api\/me$/, (request) => (request.headers()["authorization"] === `Bearer ${SECRET}` && !state.signedOut ? { body: me() } : { status: 401, body: { error: "sign in again" } }));
  server.on("PATCH", /^\/api\/me$/, (request) => {
    const body = request.postDataJSON() as { handle: string };
    if (opts.taken?.includes(body.handle.toLowerCase())) return { status: 409, body: { error: "that handle is taken", code: "handle_taken" } };
    state.handle = body.handle;
    state.renameAvailableAt = Date.now() + 14 * 86_400_000;
    return { body: me() };
  });
  server.on("POST", /^\/api\/me\/recovery$/, () => {
    state.recoveryIssuedAt = Date.now();
    return { body: { recoveryCode: "CABAL-7K2M-QX9P-H4TR-W8NB-3DFG", issuedAt: state.recoveryIssuedAt } };
  });
  server.on("POST", /^\/api\/me\/logout$/, () => {
    state.signedOut = true;
    return { status: 204 };
  });
  server.on("GET", /^\/api\/players\/([^/]+)$/, (_r, m) => ({ body: freshProfile(decodeURIComponent(m[1]!)) }));
  server.on("GET", /^\/api\/me\/notifications$/, () => ({ body: { preferences: { deadline: true, phase: true, press: true, started: true, finished: true }, devices: 0, reminderMinutes: 30 } }));
  server.on("GET", /^\/api\/push\/key$/, () => ({ body: { publicKey: null } }));
  return state;
}

/** Put an account on the device before the page loads, as if it had played here before. */
export async function signedIn(page: Page, handle = PLAYER.handle) {
  await page.addInitScript(
    ([key, value]) => {
      try {
        localStorage.setItem(key!, value!);
      } catch {
        // storage refused: the test will say so
      }
    },
    ["cabal.player", JSON.stringify({ id: PLAYER.id, handle, secret: SECRET, savedAt: 1 })],
  );
}

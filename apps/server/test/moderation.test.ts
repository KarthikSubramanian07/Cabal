/** Moderation hooks: reporting a player, the admin review list, and a burst of accounts logged for review. */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerSession, ReportsResponse } from "@cabal/protocol";
import { MULTI_ACCOUNT_REVIEW, noteAccountOrigin, originKeyOf } from "../src/moderation.js";
import { call, freshHandle, newPlayer, nextIp, serverEnv } from "./helpers.js";

const db = () => serverEnv.DB!;
const ADMIN = "test-admin-token";

const report = (secret: string | null, handle: string, body: unknown) => call(`/api/players/${handle}/report`, secret, { method: "POST", body: JSON.stringify(body) });

async function reviewList(): Promise<ReportsResponse> {
  const res = await call("/api/reports", ADMIN);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  return ReportsResponse.parse(await res.json());
}

afterEach(() => vi.restoreAllMocks());

describe("reporting a player", () => {
  it("turns away a flood from one address before reading any bearer it carries", async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 24; i++) {
      const res = await SELF.fetch("http://cabal/api/players/someone/report", {
        method: "POST",
        headers: { "cf-connecting-ip": ip, authorization: `Bearer cps_${"x".repeat(43)}` },
        body: JSON.stringify({ reason: "abuse" }),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 401)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
  });

  it("takes a signed-in player's report about someone else, once a day, for the maintainers only", async () => {
    const [ann, bob] = await Promise.all([newPlayer(), newPlayer()]);
    expect((await report(null, bob.player.handle, { reason: "abuse" })).status).toBe(401);
    expect((await report(ann.secret, freshHandle("Nobody"), { reason: "abuse" })).status).toBe(404);
    expect((await report(ann.secret, bob.player.handle, { reason: "spite" })).status).toBe(400);
    expect((await report(ann.secret, bob.player.handle, { reason: "abuse", note: "x".repeat(501) })).status).toBe(400);
    const self = await report(ann.secret, ann.player.handle, { reason: "other" });
    expect(self.status).toBe(400);
    expect(await self.json()).toMatchObject({ code: "self_report" });

    const filed = await report(ann.secret, bob.player.handle.toUpperCase(), { reason: "abuse", note: "  Threats in press.  ", gameId: "ABCDEF" });
    expect(filed.status, await filed.clone().text()).toBe(202);
    expect(await filed.json()).toEqual({ received: true });
    // Again the same day: accepted, and nothing more is kept.
    expect((await report(ann.secret, bob.player.handle, { reason: "cheating" })).status).toBe(202);
    const rows = (await db().prepare("SELECT reporter_id, reason, note, game_id FROM player_reports WHERE subject_id = ?").bind(bob.player.id).all()).results;
    expect(rows).toEqual([{ reporter_id: ann.player.id, reason: "abuse", note: "Threats in press.", game_id: "ABCDEF" }]);

    const list = await reviewList();
    expect(list.reports.find((r) => r.subject === bob.player.handle)).toMatchObject({ reporter: ann.player.handle, reason: "abuse", gameId: "ABCDEF" });
    // Nothing about a report is public: the profile does not mention it.
    expect(JSON.stringify(await (await call(`/api/players/${bob.player.handle}`, null)).json())).not.toContain("abuse");
  });

  it("keeps the review list behind the admin token", async () => {
    expect((await call("/api/reports", null)).status).toBe(401);
    expect((await call("/api/reports", "not-the-token")).status).toBe(401);
    expect((await call("/api/reports", ADMIN, { method: "POST" })).status).toBe(404);
  });

  it("forgets reports about a deleted player, and keeps theirs without their name", async () => {
    const [ann, bob, cat] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    expect((await report(ann.secret, bob.player.handle, { reason: "cheating" })).status).toBe(202);
    expect((await report(bob.secret, cat.player.handle, { reason: "other" })).status).toBe(202);
    const gone = await call("/api/me", bob.secret, { method: "DELETE", body: JSON.stringify({ handle: bob.player.handle }) });
    expect(gone.status).toBe(200);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM player_reports WHERE subject_id = ?").bind(bob.player.id).first<{ n: number }>())!.n).toBe(0);
    const theirs = await db().prepare("SELECT reporter_id, reason FROM player_reports WHERE subject_id = ?").bind(cat.player.id).all();
    expect(theirs.results).toEqual([{ reporter_id: null, reason: "other" }]);
    expect((await reviewList()).reports.find((r) => r.subject === cat.player.handle)).toMatchObject({ reporter: null });
  });
});

describe("a burst of accounts from one address", () => {
  it("is logged for review from the threshold on, keeping a daily key and never the address", async () => {
    const lines: { event: string; playerId?: string; accountsToday?: number }[] = [];
    const keep = (line: unknown) => {
      try {
        lines.push(JSON.parse(String(line)));
      } catch {
        // not one of ours
      }
    };
    vi.spyOn(console, "info").mockImplementation(keep);
    vi.spyOn(console, "log").mockImplementation(keep);
    const address = "203.0.113.77";
    const made: PlayerSession[] = [];
    for (let i = 0; i < MULTI_ACCOUNT_REVIEW + 1; i++) {
      const res = await SELF.fetch("http://cabal/api/players", { method: "POST", headers: { "cf-connecting-ip": address }, body: "{}" });
      expect(res.status).toBe(201);
      made.push(PlayerSession.parse(await res.json()));
    }
    const flagged = lines.filter((l) => l.event === "multi_account_suspect");
    expect(flagged.map((l) => l.playerId)).toEqual(made.slice(MULTI_ACCOUNT_REVIEW - 1).map((m) => m.player.id));
    expect(flagged.map((l) => l.accountsToday)).toEqual([MULTI_ACCOUNT_REVIEW, MULTI_ACCOUNT_REVIEW + 1]);
    // No line and no row carries the address.
    expect(JSON.stringify(lines)).not.toContain(address);
    const rows = (await db().prepare("SELECT * FROM account_origins WHERE accounts > ?").bind(MULTI_ACCOUNT_REVIEW).all()).results;
    expect(JSON.stringify(rows)).not.toContain(address);
    expect(rows.some((r) => (r as { accounts: number }).accounts === MULTI_ACCOUNT_REVIEW + 1)).toBe(true);
    expect((await reviewList()).busyOrigins.some((o) => o.accounts === MULTI_ACCOUNT_REVIEW + 1)).toBe(true);
  });

  it("keys each address with a secret, so the table cannot be searched for an address", async () => {
    const address = "198.51.100.23";
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const res = await SELF.fetch("http://cabal/api/players", { method: "POST", headers: { "cf-connecting-ip": address }, body: "{}" });
    expect(res.status).toBe(201);
    // Hashing every address with the public day finds nothing: the stored key is not a plain SHA-256.
    const plain = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}:${address}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await db().prepare("SELECT 1 FROM account_origins WHERE origin_key = ?").bind(plain).first()).toBeNull();
    const keyed = await originKeyOf(serverEnv, day, address);
    expect(keyed).not.toBeNull();
    expect(await db().prepare("SELECT accounts FROM account_origins WHERE origin_key = ?").bind(keyed).first()).toEqual({ accounts: 1 });
    // Another key gives another value, and the VAPID key is used only through a key derived from it.
    expect(await originKeyOf({ ORIGIN_KEY: "another" }, day, address)).not.toBe(keyed);
    const derived = await originKeyOf({ VAPID_PRIVATE_KEY: "vapid-secret" }, day, address);
    expect(derived).not.toBeNull();
    expect(derived).not.toBe(await originKeyOf({ ORIGIN_KEY: "vapid-secret" }, day, address));
  });

  it("counts nothing when the Worker has no secret to key an address with", async () => {
    const request = new Request("http://cabal/api/players", { headers: { "cf-connecting-ip": "192.0.2.200" } });
    const before = (await db().prepare("SELECT COUNT(*) AS n FROM account_origins").first<{ n: number }>())!.n;
    expect(await noteAccountOrigin({ DB: db() }, request, "pl_nobody", Date.now())).toBe(0);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM account_origins").first<{ n: number }>())!.n).toBe(before);
  });

  it("does not flag addresses that make one account each", async () => {
    const before = (await db().prepare("SELECT COUNT(*) AS n FROM account_origins WHERE accounts >= ?").bind(MULTI_ACCOUNT_REVIEW).first<{ n: number }>())!.n;
    await Promise.all([newPlayer(), newPlayer(), newPlayer(), newPlayer()]);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM account_origins WHERE accounts >= ?").bind(MULTI_ACCOUNT_REVIEW).first<{ n: number }>())!.n).toBe(before);
  });
});

/** What follows a player between devices: settings and the sandbox game, the latest write winning. */
import { describe, expect, it } from "vitest";
import { SyncResponse } from "@cabal/protocol";
import { call, newPlayer, serverEnv } from "./helpers.js";

const patch = (secret: string, body: unknown) => call("/api/me/sync", secret, { method: "PATCH", body: JSON.stringify(body) });
const read = async (secret: string) => SyncResponse.parse(await (await call("/api/me/sync", secret)).json());

describe("syncing between devices", () => {
  it("holds nothing at first, and needs the player signed in", async () => {
    const me = await newPlayer();
    expect(await read(me.secret)).toEqual({ prefs: null, prefsAt: null, sandbox: null });
    expect((await call("/api/me/sync", null)).status).toBe(401);
  });

  it("keeps settings and a sandbox game, and hands them to the player's other device", async () => {
    const me = await newPlayer();
    const res = await patch(me.secret, { prefs: { at: 1000, value: { shortcuts: false, sound: true } }, sandbox: { savedAt: 2000, body: '{"schema":2}' } });
    expect(res.status).toBe(200);
    // Another device signed in to the same account reads the same thing.
    expect(await read(me.secret)).toEqual({ prefs: { shortcuts: false, sound: true }, prefsAt: 1000, sandbox: { savedAt: 2000, body: '{"schema":2}' } });
  });

  it("keeps the latest write: an older copy from a device catching up changes nothing", async () => {
    const me = await newPlayer();
    await patch(me.secret, { prefs: { at: 5000, value: { sound: true } }, sandbox: { savedAt: 5000, body: "newer" } });
    const after = SyncResponse.parse(await (await patch(me.secret, { prefs: { at: 4000, value: { sound: false } }, sandbox: { savedAt: 4000, body: "older" } })).json());
    expect(after).toMatchObject({ prefs: { sound: true }, prefsAt: 5000, sandbox: { savedAt: 5000, body: "newer" } });
    // Settings and the sandbox are separate: a newer setting goes in beside an older game left alone.
    expect(await (await patch(me.secret, { prefs: { at: 6000, value: { sound: false } } })).json()).toMatchObject({ prefs: { sound: false }, sandbox: { body: "newer" } });
  });

  it("forgets a cleared sandbox game, and a copy older than the clearing does not bring it back", async () => {
    const me = await newPlayer();
    await patch(me.secret, { sandbox: { savedAt: 1000, body: "game" } });
    expect((await read(me.secret)).sandbox).toEqual({ savedAt: 1000, body: "game" });
    await patch(me.secret, { sandbox: { cleared: 2000 } });
    expect((await read(me.secret)).sandbox).toBeNull();
    await patch(me.secret, { sandbox: { savedAt: 1500, body: "stale" } });
    expect((await read(me.secret)).sandbox).toBeNull();
    await patch(me.secret, { sandbox: { savedAt: 2500, body: "fresh" } });
    expect((await read(me.secret)).sandbox).toEqual({ savedAt: 2500, body: "fresh" });
  });

  it("takes a long sandbox game but refuses one over the limit, and anything malformed", async () => {
    const me = await newPlayer();
    expect((await patch(me.secret, { sandbox: { savedAt: 1, body: "x".repeat(200_000) } })).status).toBe(200);
    expect((await patch(me.secret, { sandbox: { savedAt: 2, body: "x".repeat(300_000) } })).status).toBe(400);
    expect((await patch(me.secret, { prefs: { at: 3, value: { shortcuts: "yes" } } })).status).toBe(400);
  });

  it("is deleted with the account", async () => {
    const me = await newPlayer();
    await patch(me.secret, { prefs: { at: 1, value: { sound: true } } });
    const del = await call("/api/me", me.secret, { method: "DELETE", body: JSON.stringify({ handle: me.player.handle }) });
    expect(del.status).toBeLessThan(300);
    const left = await serverEnv.DB!.prepare("SELECT COUNT(*) AS n FROM player_sync WHERE player_id = ?").bind(me.player.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

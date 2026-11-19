/**
 * Web Push end to end inside workerd: subscriptions and switches in D1, the notices a room sends
 * to signed-in players who are away, and what happens when a push service says a device is gone.
 * Push services are replaced by a recorder; every message is decrypted the way a browser would.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type NotificationsResponse, PushPayload } from "@cabal/protocol";
import { deliver, notices, pushRuntime } from "../src/notify.js";
import { DEVICES_PER_PLAYER } from "../src/push-store.js";
import { toBase64Url, type VapidKeys } from "../src/push.js";
import { Client, call, createAs, deadlineIn, inRoom, newPlayer, serverEnv, sleep, start, summary, until, untilPhase } from "./helpers.js";
import { browserKeys, decrypt, vapidKeys } from "./push-helpers.js";

const realRuntime = { ...pushRuntime };
let keys: VapidKeys;
/** Every request a push service received, in order, read where it was sent (a room's body is its own). */
interface Sent {
  url: string;
  headers: Headers;
  body: Uint8Array;
}
const sent: Sent[] = [];
const record = async (request: Request) => {
  sent.push({ url: request.url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
  return respond(request);
};
let respond: (request: Request) => Response = () => new Response(null, { status: 201 });

beforeAll(async () => {
  keys = await vapidKeys();
  pushRuntime.keys = () => keys;
  pushRuntime.fetch = record;
});
afterAll(() => Object.assign(pushRuntime, realRuntime));
afterEach(() => {
  respond = () => new Response(null, { status: 201 });
});

let serial = 0;

/** A browser that has subscribed for `secret`'s player; `inbox()` reads every push it was sent. */
async function device(secret: string) {
  const ua = await browserKeys();
  const endpoint = `https://fcm.googleapis.com/fcm/send/device-${Date.now().toString(36)}-${++serial}`;
  const subscription = { endpoint, expirationTime: null, keys: { p256dh: toBase64Url(ua.publicPoint), auth: toBase64Url(ua.auth) } };
  const res = await call("/api/me/push", secret, { method: "POST", body: JSON.stringify(subscription) });
  expect(res.status, await res.clone().text()).toBe(201);
  const inbox = async (): Promise<PushPayload[]> => {
    const mine = sent.filter((r) => r.url === endpoint);
    return Promise.all(mine.map(async (r) => PushPayload.parse(JSON.parse(await decrypt(r.body, ua.publicPoint, ua.d, ua.auth)))));
  };
  return { endpoint, subscription, inbox };
}

const untilPushed = (dev: Awaited<ReturnType<typeof device>>, kind: PushPayload["kind"], count = 1) =>
  until(async () => {
    const got = (await dev.inbox()).filter((p) => p.kind === kind);
    return got.length >= count ? got : null;
  }, `${count} ${kind} push`);

async function joinAs(gameId: string, secret: string) {
  const res = await call(`/api/games/${gameId}/join`, secret, { method: "POST", body: "{}" });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { gameId: string; token: string; power: string };
}

/** Two signed-in players, each with one subscribed browser, in a game that has not started. */
async function table(settings: Record<string, unknown> = {}) {
  const ann = await newPlayer();
  const bob = await newPlayer();
  const annDevice = await device(ann.secret);
  const bobDevice = await device(bob.secret);
  const annSeat = await createAs(ann.secret, { graceSeconds: 0, ...settings });
  const bobSeat = await joinAs(annSeat.gameId, bob.secret);
  return { ann, bob, annDevice, bobDevice, annSeat, bobSeat, gameId: annSeat.gameId };
}

describe("subscribing", () => {
  it("serves the public key a browser subscribes with", async () => {
    const res = await call("/api/push/key", null);
    expect(await res.json()).toEqual({ publicKey: keys.publicKey });
    expect(res.headers.get("cache-control")).toContain("public");
  });

  it("stores a browser's subscription for a signed-in player, and only for a real push service", async () => {
    const ann = await newPlayer();
    const ua = await browserKeys();
    const good = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/gAAAA", keys: { p256dh: toBase64Url(ua.publicPoint), auth: toBase64Url(ua.auth) } };
    const post = (body: unknown, secret: string | null = ann.secret) => call("/api/me/push", secret, { method: "POST", body: JSON.stringify(body) });
    expect((await post(good, null)).status).toBe(401);
    for (const endpoint of ["http://fcm.googleapis.com/fcm/send/x", "https://example.com/push", "https://fcm.googleapis.com:8443/x", "https://user:pw@fcm.googleapis.com/x", "https://evil.fcm.googleapis.com.example/x", "not a url"]) {
      const res = await post({ ...good, endpoint });
      expect(res.status, endpoint).toBe(400);
      expect(((await res.json()) as { code?: string }).code, endpoint).toBe("bad_endpoint");
    }
    const notAPoint = Uint8Array.from(ua.publicPoint, (b, i) => (i === 0 ? 0x05 : b));
    const badKeys = await post({ ...good, keys: { p256dh: toBase64Url(notAPoint), auth: good.keys.auth } });
    expect(((await badKeys.json()) as { code?: string }).code).toBe("bad_keys");
    const ok = await post(good);
    expect(ok.status).toBe(201);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(await ok.json()).toEqual({ devices: 1 });
    // The same browser again is the same device.
    expect(await (await post(good)).json()).toEqual({ devices: 1 });
    for (const endpoint of ["https://web.push.apple.com/QAbc", "https://wns2-par02p.notify.windows.com/w/?token=AbC"]) {
      expect((await post({ ...good, endpoint })).status, endpoint).toBe(201);
    }
  });

  it("keeps a player's newest devices, moves a browser between players, and forgets on request", async () => {
    const ann = await newPlayer();
    const devices = [];
    for (let i = 0; i < DEVICES_PER_PLAYER + 2; i++) devices.push(await device(ann.secret));
    const rows = await serverEnv.DB!.prepare("SELECT endpoint FROM push_subscriptions WHERE player_id = ? ORDER BY created_at").bind(ann.player.id).all<{ endpoint: string }>();
    expect(rows.results.map((r) => r.endpoint).sort()).toEqual(devices.slice(-DEVICES_PER_PLAYER).map((d) => d.endpoint).sort());

    // Bob signs in on Ann's last browser and subscribes it: it is his now.
    const bob = await newPlayer();
    const shared = devices.at(-1)!;
    expect((await call("/api/me/push", bob.secret, { method: "POST", body: JSON.stringify(shared.subscription) })).status).toBe(201);
    const owner = await serverEnv.DB!.prepare("SELECT player_id FROM push_subscriptions WHERE endpoint = ?").bind(shared.endpoint).first<{ player_id: string }>();
    expect(owner?.player_id).toBe(bob.player.id);

    // Ann cannot forget Bob's browser; Bob can.
    const forget = (secret: string) => call("/api/me/push", secret, { method: "DELETE", body: JSON.stringify({ endpoint: shared.endpoint }) });
    expect((await forget(ann.secret)).status).toBe(204);
    expect((await (await call("/api/me/notifications", bob.secret)).json() as NotificationsResponse).devices).toBe(1);
    expect((await forget(bob.secret)).status).toBe(204);
    expect((await (await call("/api/me/notifications", bob.secret)).json() as NotificationsResponse).devices).toBe(0);
  });

  it("forgets a device's subscription when that device signs out", async () => {
    const ann = await newPlayer();
    const dev = await device(ann.secret);
    expect((await call("/api/me/logout", ann.secret, { method: "POST", body: "{}" })).status).toBe(204);
    const row = await serverEnv.DB!.prepare("SELECT endpoint FROM push_subscriptions WHERE endpoint = ?").bind(dev.endpoint).first();
    expect(row).toBeNull();
  });

  it("keeps switches per kind of notice, all on to start with", async () => {
    const ann = await newPlayer();
    const get = async () => (await (await call("/api/me/notifications", ann.secret)).json()) as NotificationsResponse;
    expect(await get()).toEqual({ preferences: { deadline: true, phase: true, press: true, started: true, finished: true }, devices: 0, reminderMinutes: 60 });
    const patch = (body: unknown) => call("/api/me/notifications", ann.secret, { method: "PATCH", body: JSON.stringify(body) });
    expect(((await (await patch({ press: false, phase: false })).json()) as NotificationsResponse).preferences).toEqual({ deadline: true, phase: false, press: false, started: true, finished: true });
    expect(((await (await patch({ phase: true })).json()) as NotificationsResponse).preferences.phase).toBe(true);
    expect((await get()).preferences.press).toBe(false);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ press: "off" })).status).toBe(400);
    expect((await call("/api/me/notifications", null)).status).toBe(401);
  });
});

describe("what a room tells players who are away", () => {
  it("tells each away player the game began, as which power, and links to it", async () => {
    const t = await table();
    await start(t.annSeat);
    const [annStarted] = await untilPushed(t.annDevice, "started");
    const [bobStarted] = await untilPushed(t.bobDevice, "started");
    expect(annStarted).toMatchObject({ gameId: t.gameId, title: "The game has begun", url: `/g/${t.gameId}`, tag: `${t.gameId}-started` });
    expect(annStarted!.body).toContain(`You play ${t.annSeat.power.charAt(0)}${t.annSeat.power.slice(1).toLowerCase()}`);
    expect(bobStarted!.body).toContain("Spring 1901 movement is open for orders");
    // A push never carries a seat token or a player secret.
    for (const r of sent) expect(r.headers.get("authorization")).toMatch(/^vapid /);
    expect(JSON.stringify([annStarted, bobStarted])).not.toContain(t.annSeat.token);
    const request = sent.find((r) => r.url === t.bobDevice.endpoint)!;
    expect(request.headers.get("urgency")).toBe("high");
    expect(request.headers.get("topic")).toBe(`${t.gameId}-started`);
  });

  it("says a private dispatch came for someone away, never what it says, and nothing to someone watching", async () => {
    const t = await table();
    await start(t.annSeat);
    const ann = await Client.connect(t.gameId, t.annSeat.token);
    await ann.next("welcome", (m) => m.p.power !== null);
    ann.send({ t: "press.send", id: "p1", p: { to: t.bobSeat.power, body: "Meet me in Burgundy, quietly" } });
    await ann.next("press", (m) => m.id === "p1");
    const [press] = await untilPushed(t.bobDevice, "press");
    expect(press!.title).toBe(`A private dispatch from ${t.annSeat.power.charAt(0)}${t.annSeat.power.slice(1).toLowerCase()}`);
    expect(JSON.stringify(press)).not.toContain("Burgundy");
    // Public press is for the table, not a push; and the sender, who is watching, is never told.
    ann.send({ t: "press.send", id: "p2", p: { to: "ALL", body: "Peace in our time" } });
    await ann.next("press", (m) => m.id === "p2");
    // Bob opens the game: the next dispatch reaches his screen, not his phone.
    const bob = await Client.connect(t.gameId, t.bobSeat.token);
    await bob.next("welcome", (m) => m.p.power !== null);
    ann.send({ t: "press.send", id: "p3", p: { to: t.bobSeat.power, body: "Are you there?" } });
    await bob.next("press", (m) => m.p.body === "Are you there?");
    await sleep(200);
    expect((await t.bobDevice.inbox()).filter((p) => p.kind === "press")).toHaveLength(1);
    expect((await t.annDevice.inbox()).filter((p) => p.kind === "press")).toHaveLength(0);
    ann.close();
    bob.close();
  });

  it("tells an away player once per sender and phase however many dispatches come", async () => {
    const t = await table();
    await start(t.annSeat);
    const ann = await Client.connect(t.gameId, t.annSeat.token);
    await ann.next("welcome", (m) => m.p.power !== null);
    for (let i = 0; i < 12; i++) {
      ann.send({ t: "press.send", id: `m${i}`, p: { to: t.bobSeat.power, body: `ping ${i}` } });
      await ann.next("press", (m) => m.id === `m${i}`);
      await sleep(110); // under the socket's token bucket
    }
    await untilPushed(t.bobDevice, "press");
    await sleep(300);
    expect((await t.bobDevice.inbox()).filter((p) => p.kind === "press")).toHaveLength(1);
    // A new phase is new mail.
    await deadlineIn(t.gameId);
    await untilPhase(t.gameId, (phase) => phase !== "S1901M");
    ann.send({ t: "press.send", id: "next", p: { to: t.bobSeat.power, body: "and again" } });
    await ann.next("press", (m) => m.id === "next");
    await untilPushed(t.bobDevice, "press", 2);
    await sleep(200);
    expect((await t.bobDevice.inbox()).filter((p) => p.kind === "press")).toHaveLength(2);
    ann.close();
  });

  it("tells away players who have orders to write that a phase resolved", async () => {
    const t = await table();
    await start(t.annSeat);
    await deadlineIn(t.gameId);
    await untilPhase(t.gameId, (phase) => phase !== "S1901M");
    const [phase] = await untilPushed(t.bobDevice, "phase");
    expect(phase).toMatchObject({ title: "Spring 1901 movement is resolved", tag: `${t.gameId}-phase` });
    expect(phase!.body).toContain("Fall 1901 movement is open");
  });

  it("reminds an away player with no orders in before the deadline, once, and not one who has ordered", async () => {
    const t = await table();
    await start(t.annSeat);
    // Ann hands in her orders and leaves; Bob never shows up.
    const ann = await Client.connect(t.gameId, t.annSeat.token);
    const welcome = await ann.next("welcome", (m) => m.p.power !== null);
    const units = welcome.p.state.units[t.annSeat.power] ?? [];
    ann.send({ t: "orders.set", id: "o1", p: { phase: "S1901M", orders: units.map((u: string) => `${u} H`) } });
    await ann.next("orders.ack", (m) => m.id === "o1");
    ann.close();
    await ann.untilClosed();
    // The deadline is an hour and a moment away: the reminder (60 minutes ahead) is due now.
    const deadlineAt = Date.now() + 60 * 60_000 + 150;
    await inRoom(t.gameId, (room) => {
      room.meta.deadlineAt = deadlineAt;
      room.kv.put("meta", room.meta);
      room.rearm();
    });
    const [reminder] = await untilPushed(t.bobDevice, "deadline");
    expect(reminder).toMatchObject({ title: "Orders due in 1 hour", tag: `${t.gameId}-deadline` });
    expect(reminder!.body).toContain("Spring 1901 movement");
    // Once per phase: the alarm now points at the deadline itself.
    const after = await inRoom(t.gameId, async (room, state) => ({ alarm: await state.storage.getAlarm(), reminded: (room.meta as unknown as { remindedPhase: string | null }).remindedPhase }));
    expect(after).toEqual({ alarm: deadlineAt, reminded: "S1901M" });
    await sleep(200);
    expect((await t.annDevice.inbox()).filter((p) => p.kind === "deadline")).toHaveLength(0);
    expect((await t.bobDevice.inbox()).filter((p) => p.kind === "deadline")).toHaveLength(1);
    const res = sent.find((r) => r.url === t.bobDevice.endpoint && r.headers.get("topic") === `${t.gameId}-deadline`)!;
    expect(Number(res.headers.get("ttl"))).toBeGreaterThan(3500);
  });

  it("sets no reminder in a phase too short for one", async () => {
    const t = await table({ pacing: "live", movementSeconds: 3600 });
    await start(t.annSeat);
    const s = await summary(t.gameId);
    expect(await inRoom(t.gameId, (_room, state) => state.storage.getAlarm())).toBe(s.deadlineAt);
  });

  it("tells away players how the game ended", async () => {
    const t = await table();
    await start(t.annSeat);
    await inRoom(t.gameId, (room) => {
      const internals = room as unknown as { atomic(f: () => void): void; conclude(result: string, sharers: string[], reason: string): void };
      internals.atomic(() => internals.conclude("solo", [t.bobSeat.power], "solo"));
      room.settle();
    });
    const [finished] = await untilPushed(t.annDevice, "finished");
    expect(finished!.title).toBe(`${t.bobSeat.power.charAt(0)}${t.bobSeat.power.slice(1).toLowerCase()} takes Europe`);
    await untilPushed(t.bobDevice, "finished");
  });

  it("honours a player's switches", async () => {
    const t = await table();
    expect((await call("/api/me/notifications", t.bob.secret, { method: "PATCH", body: JSON.stringify({ started: false }) })).status).toBe(200);
    await start(t.annSeat);
    await untilPushed(t.annDevice, "started");
    await sleep(200);
    expect(await t.bobDevice.inbox()).toEqual([]);
  });
});

describe("delivery", () => {
  it("forgets a subscription the push service says is gone, and counts other failures", async () => {
    const ann = await newPlayer();
    const gone = await device(ann.secret);
    const flaky = await device(ann.secret);
    const fine = await device(ann.secret);
    respond = (request) => new Response(null, { status: request.url === gone.endpoint ? 410 : request.url === flaky.endpoint ? 503 : 201 });
    const report = await deliver(serverEnv, [notices.press("ABCDEF", ann.player.id, "FRANCE")]);
    expect(report).toEqual({ devices: 3, delivered: 1, gone: 1, failed: 1 });
    const rows = await serverEnv.DB!.prepare("SELECT endpoint, failures FROM push_subscriptions WHERE player_id = ? ORDER BY endpoint").bind(ann.player.id).all<{ endpoint: string; failures: number }>();
    expect(Object.fromEntries(rows.results.map((r) => [r.endpoint, r.failures]))).toEqual({ [flaky.endpoint]: 1, [fine.endpoint]: 0 });
    // A delivery that goes through again starts the count again.
    respond = () => new Response(null, { status: 201 });
    await deliver(serverEnv, [notices.press("ABCDEF", ann.player.id, "FRANCE")]);
    const flakyRow = await serverEnv.DB!.prepare("SELECT failures FROM push_subscriptions WHERE endpoint = ?").bind(flaky.endpoint).first<{ failures: number }>();
    expect(flakyRow?.failures).toBe(0);
  });

  it("survives a push service that cannot be reached", async () => {
    const ann = await newPlayer();
    await device(ann.secret);
    pushRuntime.fetch = async () => {
      throw new Error("connection reset");
    };
    try {
      expect(await deliver(serverEnv, [notices.press("ABCDEF", ann.player.id, "FRANCE")])).toMatchObject({ devices: 1, failed: 1 });
    } finally {
      pushRuntime.fetch = record;
    }
  });

  it("sends nothing and schedules no reminder where push is not configured", async () => {
    const ann = await newPlayer();
    await device(ann.secret);
    pushRuntime.keys = () => null;
    try {
      const before = sent.length;
      expect(await deliver(serverEnv, [notices.press("ABCDEF", ann.player.id, "FRANCE")])).toEqual({ devices: 0, delivered: 0, gone: 0, failed: 0 });
      expect(sent.length).toBe(before);
      const seat = await createAs(ann.secret, { graceSeconds: 0 });
      await start(seat);
      const s = await summary(seat.gameId);
      expect(await inRoom(seat.gameId, (_room, state) => state.storage.getAlarm())).toBe(s.deadlineAt);
      expect(((await (await call("/api/push/key", null)).json()) as { publicKey: string | null }).publicKey).toBeNull();
    } finally {
      pushRuntime.keys = () => keys;
    }
  });
});

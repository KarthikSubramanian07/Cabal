import { describe, expect, it } from "vitest";
import { ApiError, CabalError, CabalSocket, type SocketLike, backoffDelay, createApi } from "./client.js";
import { GameSettings, type ServerMessage } from "./index.js";

/** A socket the test drives by hand. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private handlers: Record<string, ((event: never) => void)[]> = {};

  addEventListener(type: string, listener: (event: never) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  private fire(type: string, event: unknown): void {
    for (const handler of this.handlers[type] ?? []) handler(event as never);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }
  // what the "server" does
  open(): void {
    this.readyState = 1;
    this.fire("open", {});
  }
  push(frame: ServerMessage | string): void {
    this.fire("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  drop(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  frames(): { t: string; id?: string; p: Record<string, unknown> }[] {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as { t: string; id?: string; p: Record<string, unknown> });
  }
}

/** Timers the test advances by hand. */
function clock() {
  let now = 1_000_000;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

const welcome = (seq: number, power: "FRANCE" | null, id?: string): ServerMessage => ({
  t: "welcome",
  ...(id ? { id } : {}),
  p: {
    protocol: 2,
    gameId: "ABCDEF",
    settings: GameSettings.parse({}),
    status: "active",
    power,
    host: "FRANCE",
    phase: "S1901M",
    state: { name: "S1901M", units: {}, centers: {}, homes: {}, retreats: {}, builds: {} },
    seats: [],
    deadlineAt: null,
    serverTime: 5_000_000,
    seq,
    orders: [],
    defaults: [],
    press: [],
    pressMore: false,
    unread: {},
    votes: { phase: "S1901M", draw: [], required: [], hidden: false, cast: 0, yes: 0 },
    history: [],
    finished: null,
  },
});

const status = (seq: number): ServerMessage => ({ t: "status", seq, p: { status: "active", reason: `frame ${seq}` } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { token?: string; heartbeatMs?: number; onReply?: (sent: string, ms: number) => void } = { token: "ABCDEF.FRANCE.secret" }) {
  const time = clock();
  const sockets: FakeSocket[] = [];
  let failing = 0;
  const socket = new CabalSocket({
    connect: () => {
      if (failing > 0) {
        failing--;
        throw new Error("network down");
      }
      const ws = new FakeSocket();
      sockets.push(ws);
      return ws;
    },
    ...(options.token ? { token: options.token } : {}),
    heartbeatMs: options.heartbeatMs ?? 0,
    ...(options.onReply ? { onReply: options.onReply } : {}),
    pongTimeoutMs: 1_000,
    backoff: { minMs: 100, maxMs: 1_600, factor: 2, jitter: 0 },
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  const delivered: { t: string; seq: number | undefined; replayed: boolean }[] = [];
  socket.on("frame", (frame, meta) => delivered.push({ t: frame.t, seq: frame.seq, replayed: meta.replayed }));
  const statuses: string[] = [];
  socket.on("status", (s) => statuses.push(s));
  /** Open the latest socket and answer the hello with a welcome at `seq`. */
  const bind = async (seq: number) => {
    await flush();
    const ws = sockets.at(-1)!;
    ws.open();
    ws.push(welcome(0, null));
    const hello = ws.frames().find((f) => f.t === "hello")!;
    ws.push(welcome(seq, "FRANCE", hello.id));
    return ws;
  };
  return { socket, sockets, time, delivered, statuses, bind, failNext: (n: number) => (failing = n) };
}

describe("backoffDelay", () => {
  it("doubles from the minimum to the ceiling and randomises part of each wait away", () => {
    const none = () => 0;
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, {}, none))).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffDelay(2, { jitter: 0.5 }, () => 1)).toBe(1000);
    expect(backoffDelay(0, { minMs: 100, jitter: 0 })).toBe(100);
  });
});

describe("CabalSocket", () => {
  it("binds with a hello as its first frame and treats the seat's welcome, not the spectator's, as the start", async () => {
    const h = harness();
    const started = h.socket.start();
    await flush();
    const ws = h.sockets[0]!;
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.frames().map((f) => f.t)).toEqual(["hello"]);
    expect(ws.frames()[0]!.p).toEqual({ token: "ABCDEF.FRANCE.secret" });
    ws.push(welcome(4, null));
    expect(h.socket.status).toBe("connecting");
    ws.push(welcome(4, "FRANCE", ws.frames()[0]!.id));
    expect((await started).power).toBe("FRANCE");
    expect(h.socket).toMatchObject({ status: "open", power: "FRANCE", seq: 4 });
    expect(h.statuses).toEqual(["connecting", "open"]);
    // The server's clock is ahead of ours by four million milliseconds.
    expect(h.socket.serverNow() - h.time.now()).toBe(4_000_000);
  });

  it("is a spectator without a token: no hello, and the first welcome is the start", async () => {
    const h = harness({});
    const started = h.socket.start();
    await flush();
    h.sockets[0]!.open();
    h.sockets[0]!.push(welcome(2, null));
    expect((await started).power).toBeNull();
    expect(h.sockets[0]!.frames()).toEqual([]);
  });

  it("delivers each numbered frame once and in order, dropping anything at or before its cursor", async () => {
    const h = harness();
    void h.socket.start();
    const ws = await h.bind(4);
    for (const seq of [3, 4, 5, 5, 6]) ws.push(status(seq));
    ws.push({ t: "press.unread", p: { unread: {} } });
    expect(h.delivered.filter((d) => d.t !== "welcome")).toEqual([
      { t: "status", seq: 5, replayed: false },
      { t: "status", seq: 6, replayed: false },
      { t: "press.unread", seq: undefined, replayed: false },
    ]);
    expect(h.socket.seq).toBe(6);
    // Garbage and frames this build does not know are skipped without a fuss.
    ws.push("not json");
    ws.push(JSON.stringify({ t: "from.the.future", seq: 7, p: {} }));
    expect(h.socket.seq).toBe(6);
  });

  it("matches a reply to its request by id, and rejects with the server's error code", async () => {
    const h = harness();
    void h.socket.start();
    const ws = await h.bind(1);
    const ack = h.socket.setOrders("S1901M", ["A PAR H"]);
    const sent = ws.frames().at(-1)!;
    expect(sent).toMatchObject({ t: "orders.set", p: { phase: "S1901M", orders: ["A PAR H"] } });
    ws.push({ t: "orders.ack", id: "someone-else", p: { phase: "S1901M", accepted: [], rejected: [], verdicts: [] } });
    ws.push({ t: "orders.ack", id: sent.id!, p: { phase: "S1901M", accepted: ["A PAR H"], rejected: [], verdicts: [] } });
    expect((await ack).p.accepted).toEqual(["A PAR H"]);

    const refused = h.socket.press("ALL", "hello");
    ws.push({ t: "error", id: ws.frames().at(-1)!.id!, p: { code: "no_press", message: "gunboat: no press" } });
    await expect(refused).rejects.toMatchObject({ name: "CabalError", code: "no_press" });

    const unanswered = h.socket.extend("S1901M");
    h.time.advance(15_000);
    await expect(unanswered).rejects.toMatchObject({ code: "timeout" });

    const cut = h.socket.setOrders("S1901M", []);
    ws.drop();
    await expect(cut).rejects.toMatchObject({ code: "disconnected" });
    await expect(h.socket.setOrders("S1901M", [])).rejects.toMatchObject({ code: "not_connected" });
  });

  it("times each answered request from send to reply, and nothing that failed", async () => {
    const timed: [string, number][] = [];
    const h = harness({ token: "ABCDEF.FRANCE.secret", onReply: (sent, ms) => void timed.push([sent, ms]) });
    void h.socket.start();
    const ws = await h.bind(1);
    const ack = h.socket.setOrders("S1901M", ["A PAR H"]);
    h.time.advance(42);
    ws.push({ t: "orders.ack", id: ws.frames().at(-1)!.id!, p: { phase: "S1901M", accepted: ["A PAR H"], rejected: [], verdicts: [] } });
    await ack;
    const refused = h.socket.press("ALL", "hello");
    h.time.advance(5);
    ws.push({ t: "error", id: ws.frames().at(-1)!.id!, p: { code: "no_press", message: "gunboat: no press" } });
    await expect(refused).rejects.toMatchObject({ code: "no_press" });
    const unanswered = h.socket.setOrders("S1901M", []);
    h.time.advance(15_000);
    await expect(unanswered).rejects.toMatchObject({ code: "timeout" });
    expect(timed).toEqual([["orders.set", 42]]);
  });

  it("delivers the reply even when the timing listener throws", async () => {
    const h = harness({ token: "ABCDEF.FRANCE.secret", onReply: () => { throw new Error("listener broke"); } });
    void h.socket.start();
    const ws = await h.bind(1);
    const ack = h.socket.setOrders("S1901M", ["A PAR H"]);
    ws.push({ t: "orders.ack", id: ws.frames().at(-1)!.id!, p: { phase: "S1901M", accepted: ["A PAR H"], rejected: [], verdicts: [] } });
    expect((await ack).p.accepted).toEqual(["A PAR H"]);
  });

  it("resumes after a drop: replays what it missed in order, then the snapshot, then what came after, each frame once", async () => {
    const h = harness();
    void h.socket.start();
    const first = await h.bind(1);
    first.push(status(2));
    first.push(status(3));
    first.drop();
    expect(h.socket.status).toBe("waiting");
    h.time.advance(100);
    await flush();
    h.delivered.length = 0;

    const ws = h.sockets[1]!;
    ws.open();
    ws.push(welcome(7, null));
    const hello = ws.frames().find((f) => f.t === "hello")!;
    ws.push(welcome(7, "FRANCE", hello.id));
    // Nothing is delivered yet: the client asks for the frames after its cursor first.
    expect(h.delivered).toEqual([]);
    const sync = ws.frames().find((f) => f.t === "sync")!;
    expect(sync.p).toEqual({ since: 3 });
    // Frames the server had already queued for this socket arrive before the replay does.
    ws.push(status(7));
    ws.push(status(8));
    // The replay, in two pages, with a live frame in between.
    ws.push(status(4));
    ws.push(status(5));
    ws.push({ t: "synced", id: sync.id!, p: { seq: 5, more: true, gap: false } });
    ws.push(status(9));
    const sync2 = ws.frames().filter((f) => f.t === "sync")[1]!;
    expect(sync2.p).toEqual({ since: 5 });
    ws.push(status(6));
    ws.push(status(7));
    ws.push(status(8));
    ws.push({ t: "synced", id: sync2.id!, p: { seq: 9, more: false, gap: false } });

    expect(h.delivered).toEqual([
      { t: "status", seq: 4, replayed: true },
      { t: "status", seq: 5, replayed: true },
      { t: "status", seq: 6, replayed: true },
      { t: "status", seq: 7, replayed: true },
      { t: "welcome", seq: undefined, replayed: false },
      { t: "status", seq: 8, replayed: false },
      { t: "status", seq: 9, replayed: false },
    ]);
    expect(h.socket).toMatchObject({ seq: 9, status: "open", attempt: 0 });
    ws.push(status(10));
    expect(h.delivered.at(-1)).toEqual({ t: "status", seq: 10, replayed: false });
  });

  it("does not ask for a replay when it missed nothing, and trusts the snapshot alone when the server reports a gap", async () => {
    const h = harness();
    void h.socket.start();
    (await h.bind(3)).drop();
    h.time.advance(100);
    const same = await h.bind(3);
    expect(same.frames().some((f) => f.t === "sync")).toBe(false);
    expect(h.socket.status).toBe("open");

    same.drop();
    h.time.advance(100);
    h.delivered.length = 0;
    const ws = await h.bind(9_000);
    const sync = ws.frames().find((f) => f.t === "sync")!;
    ws.push(status(8_999));
    ws.push(status(9_001));
    ws.push({ t: "synced", id: sync.id!, p: { seq: 9_000, more: false, gap: true } });
    expect(h.delivered).toEqual([
      { t: "welcome", seq: undefined, replayed: false },
      { t: "status", seq: 9_001, replayed: false },
    ]);
    expect(h.socket.seq).toBe(9_001);
  });

  it("backs off between failed attempts and starts again from the minimum after a welcome", async () => {
    const h = harness();
    void h.socket.start();
    (await h.bind(1)).drop();
    h.failNext(3);
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      waits.push(h.time.pending()[0]!);
      h.time.advance(waits.at(-1)!);
      await flush();
    }
    expect(waits).toEqual([100, 200, 400, 800]);
    const ws = await h.bind(1);
    expect(h.socket).toMatchObject({ status: "open", attempt: 0 });
    ws.drop();
    expect(h.time.pending()[0]).toBe(100);
  });

  it("stops for good when the server refuses the token or gives the seat away", async () => {
    for (const [code, name] of [[4401, "bad_token"], [4001, "seat_reassigned"]] as const) {
      const h = harness();
      const fatal: CabalError[] = [];
      h.socket.on("fatal", (e) => fatal.push(e));
      const started = h.socket.start();
      await flush();
      const ws = h.sockets[0]!;
      ws.open();
      ws.push({ t: "error", id: ws.frames()[0]!.id!, p: { code: "bad_token", message: "that seat token is not valid" } });
      ws.drop(code, "refused");
      await expect(started).rejects.toMatchObject({ code: name });
      expect(h.socket.status).toBe("closed");
      expect(fatal.map((e) => e.code)).toEqual([name]);
      h.time.advance(60_000);
      await flush();
      expect(h.sockets).toHaveLength(1);
    }
  });

  it("pings on a timer and treats a missing pong as a dead connection", async () => {
    const h = harness({ token: "ABCDEF.FRANCE.secret", heartbeatMs: 5_000 });
    void h.socket.start();
    const ws = await h.bind(1);
    h.time.advance(5_000);
    expect(ws.sent.filter((s) => s === "ping")).toHaveLength(1);
    ws.push("pong");
    h.time.advance(5_000);
    expect(ws.sent.filter((s) => s === "ping")).toHaveLength(2);
    expect(h.socket.status).toBe("open");
    // This time nothing answers.
    h.time.advance(1_000);
    expect(ws.closedWith).toEqual({ code: 4000, reason: "pong timeout" });
    expect(h.socket.status).toBe("waiting");
    h.time.advance(100);
    await h.bind(1);
    expect(h.socket.status).toBe("open");
  });

  it("closes for good on request and reconnects on request", async () => {
    const h = harness();
    void h.socket.start();
    const ws = await h.bind(1);
    h.socket.reconnect();
    expect(ws.closedWith?.code).toBe(4000);
    const second = await h.bind(1);
    h.socket.close();
    expect(second.closedWith).toEqual({ code: 1000, reason: "bye" });
    expect(h.socket.status).toBe("closed");
    h.time.advance(60_000);
    await flush();
    expect(h.sockets).toHaveLength(2);
  });
});

describe("reconnecting on request", () => {
  it("dials at once after a long outage instead of waiting out a grown backoff", async () => {
    const time = clock();
    let dials = 0;
    const socket = new CabalSocket({
      connect: () => {
        dials++;
        throw new Error("server down");
      },
      random: () => 0,
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
      heartbeatMs: 0,
    });
    void socket.start().catch(() => undefined);
    await flush();
    // About a minute of outage: the backoff has grown to its ceiling.
    for (let i = 0; i < 12; i++) {
      time.advance(10_000);
      await flush();
    }
    expect(socket.attempt).toBeGreaterThanOrEqual(6);
    const before = dials;
    socket.reconnect();
    await flush();
    expect(dials).toBe(before + 1);
    expect(socket.attempt).toBe(1);
  });

  it("leaves one retry waiting however often it is pressed", async () => {
    const time = clock();
    const socket = new CabalSocket({
      connect: () => {
        throw new Error("server down");
      },
      random: () => 0,
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
      heartbeatMs: 0,
    });
    void socket.start().catch(() => undefined);
    await flush();
    expect(time.pending()).toHaveLength(1);
    socket.reconnect();
    socket.reconnect();
    socket.reconnect();
    await flush();
    expect(time.pending()).toHaveLength(1);
  });
});

describe("createApi", () => {
  it("sends seat tokens as bearer headers, parses what comes back and turns failures into ApiError", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const replies: Response[] = [
      Response.json({ gameId: "ABCDEF", token: "ABCDEF.FRANCE.secret", power: "FRANCE" }),
      Response.json({ gameId: "ABCDEF", ledger: {}, entries: [] }),
      Response.json({ status: "open", games: [] }),
      Response.json({ error: "no such game" }, { status: 404 }),
    ];
    const api = createApi({ baseUrl: "https://example.test/", fetch: async (url, init) => (calls.push({ url, init }), replies.shift()!) });
    expect(await api.createGame({ name: "Ann", settings: { visibility: "public" } })).toMatchObject({ power: "FRANCE" });
    expect(calls[0]).toMatchObject({ url: "https://example.test/api/games", init: { method: "POST" } });
    await api.ledger("ABCDEF", "ABCDEF.FRANCE.secret");
    expect(calls[1]!.url).toBe("https://example.test/api/games/ABCDEF/ledger");
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer ABCDEF.FRANCE.secret");
    expect(calls[1]!.url).not.toContain("secret");
    expect(await api.listLive("open", { limit: 5 })).toEqual([]);
    expect(calls[2]!.url).toBe("https://example.test/api/games?status=open&limit=5");
    const failure = await api.summary("NOSUCH").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 404, message: "no such game" });
  });

  it("covers the player routes, with the player secret as the bearer and never in a URL", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const summary = { id: "pl_1", handle: "Talleyrand", createdAt: 1 };
    const replies: Response[] = [
      Response.json({ player: summary, secret: "cps_secret" }, { status: 201 }),
      Response.json({ recoveryCode: "CABAL-AAAA-BBBB-CCCC-DDDD-EEEE", issuedAt: 2 }),
      new Response(null, { status: 204 }),
      Response.json({ ladder: "overall", entries: [], offset: 25, limit: 25, next: null }),
      Response.json({ gameId: "ABCDEF", token: "ABCDEF.FRANCE.secret", power: "FRANCE" }),
    ];
    const api = createApi({ fetch: async (url, init) => (calls.push({ url, init }), replies.shift()!) });
    expect(await api.createPlayer("Talleyrand")).toEqual({ player: summary, secret: "cps_secret" });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ handle: "Talleyrand" });
    expect((await api.issueRecoveryCode("cps_secret")).recoveryCode).toMatch(/^CABAL-/);
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer cps_secret");
    expect(await api.logout("cps_secret", true)).toBeNull();
    expect(JSON.parse(calls[2]!.init!.body as string)).toEqual({ everywhere: true });
    await api.leaderboard({ offset: 25 });
    expect(calls[3]!.url).toBe("/api/leaderboard?offset=25");
    await api.joinGame("ABCDEF", {}, "cps_secret");
    expect((calls[4]!.init!.headers as Record<string, string>).authorization).toBe("Bearer cps_secret");
    for (const call of calls) expect(call.url).not.toContain("secret");
  });

  it("reads a rating history and deletes an account, the confirming handle in the body", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const point = { gameId: "ABCDEF", power: "FRANCE", result: "draw", score: 0.5, ratingBefore: 1500, rdBefore: 350, ratingAfter: 1540, rdAfter: 290, at: 3 };
    const replies: Response[] = [Response.json({ ladder: "overall", points: [point], more: false }), Response.json({ deleted: true, games: 2, unreached: 0 })];
    const api = createApi({ fetch: async (url, init) => (calls.push({ url, init }), replies.shift()!) });
    expect((await api.ratingHistory("Tal leyrand", 20)).points).toEqual([point]);
    expect(calls[0]!.url).toBe("/api/players/Tal%20leyrand/ratings?limit=20");
    expect(await api.deleteAccount("cps_secret", "Talleyrand")).toEqual({ deleted: true, games: 2, unreached: 0 });
    expect(calls[1]).toMatchObject({ url: "/api/me", init: { method: "DELETE" } });
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ handle: "Talleyrand" });
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer cps_secret");
  });

  it("covers push, notification preferences and metrics, with secrets as bearers only", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const preferences = { deadline: true, phase: false, press: true, started: true, finished: true };
    const replies: Response[] = [
      Response.json({ publicKey: "BPublicKey" }),
      Response.json({ devices: 1 }, { status: 201 }),
      new Response(null, { status: 204 }),
      Response.json({ preferences, devices: 1, reminderMinutes: 60 }),
      new Response(null, { status: 204 }),
      Response.json({ from: 1, to: 2, metrics: [] }),
    ];
    const api = createApi({ fetch: async (url, init) => (calls.push({ url, init }), replies.shift()!) });
    expect(await api.pushKey()).toBe("BPublicKey");
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/x", expirationTime: null, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };
    expect(await api.subscribePush("cps_secret", subscription)).toEqual({ devices: 1 });
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual(subscription);
    expect(await api.unsubscribePush("cps_secret", subscription.endpoint)).toBeNull();
    expect(calls[2]!.init!.method).toBe("DELETE");
    expect(await api.setNotifications("cps_secret", { phase: false })).toEqual(preferences);
    expect(calls[3]!.init!.method).toBe("PATCH");
    expect(await api.sendMetrics([{ metric: "order_rtt", ms: 42 }])).toBeNull();
    expect((calls[4]!.init!.headers as Record<string, string>).authorization).toBeUndefined();
    expect((await api.metrics("admin-token", 7)).metrics).toEqual([]);
    expect(calls[5]!.url).toBe("/api/metrics?days=7");
    expect((calls[5]!.init!.headers as Record<string, string>).authorization).toBe("Bearer admin-token");
    for (const call of calls) expect(call.url).not.toMatch(/secret|admin-token/);
  });
});

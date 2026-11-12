import { adjudicateStrict } from "./adjudicate-guard.js";
/**
 * GameRoom: one Durable Object per game.
 *
 * Owns the seats, the engine game (persisted as MILA saved game JSON), orders,
 * press and pledges in SQLite, every WebSocket (hibernating, tagged by power),
 * and one alarm for the phase deadline. Adjudicate, persist and broadcast happen
 * in one place with no network hop.
 */
import { DurableObject } from "cloudflare:workers";
import {
  type GameSettings as Settings,
  GameSettings,
  type OrderResultView,
  type PledgeView,
  type PowerName,
  type PressView,
  type SeatView,
  type ServerMessage,
  type StateView,
  parseClientMessage,
  sumOfSquares,
} from "@cabal/protocol";
import type { Env } from "./env.js";
import {
  Game,
  POWERS,
  canonicalOrder,
  engineReady,
  pledgeCommit,
  pledgeReceipt,
  randomNonce,
} from "./engine.js";
import { hashToken, mintToken, parseToken, randomId } from "./tokens.js";
import { ADJUDICATION_RETRY_MS, recoverSchedule } from "./deadlines.js";

type Status = "lobby" | "active" | "paused" | "finished" | "abandoned";

/** Abuse limits. A room is single threaded, so every unbounded input is a way to stall a game. */
const LIMITS = {
  /** Token bucket per socket: burst size and refill per second. */
  burst: 30,
  refillPerSecond: 10,
  /** Press messages one power may send in one phase. */
  pressPerPhase: 60,
  /** Events replayed by one `sync` request; clients page with `since`. */
  syncPage: 500,
  /** Press messages included in a welcome frame (the most recent ones). */
  welcomePress: 500,
  spectators: 200,
} as const;

interface Meta {
  id: string;
  settings: Settings;
  status: Status;
  createdAt: number;
  deadlineAt: number | null;
  creator: PowerName;
  finished: { result: "solo" | "draw"; winners: PowerName[]; scores: Record<string, number> } | null;
  pauseReason?: string | null;
  noOrderPhases?: number;
  serverUrl?: string;
}

interface SeatRow extends Record<string, SqlStorageValue> {
  power: PowerName;
  kind: "human" | "ai" | "open" | "civil_disorder";
  name: string | null;
  token_hash: string | null;
  ready: number;
  missed: number;
  eliminated: number;
}

interface Attachment {
  power: PowerName | null;
  clientIp?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seats (
  power TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  token_hash TEXT,
  ready INTEGER NOT NULL DEFAULT 0,
  missed INTEGER NOT NULL DEFAULT 0,
  eliminated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  phase TEXT NOT NULL,
  power TEXT NOT NULL,
  orders_json TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (phase, power)
);
CREATE TABLE IF NOT EXISTS defaults (
  power TEXT PRIMARY KEY,
  orders_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS press (
  id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  pledge_id TEXT
);
CREATE TABLE IF NOT EXISTS pledges (
  id TEXT PRIMARY KEY,
  pledger TEXT NOT NULL,
  audience TEXT NOT NULL,
  phase TEXT NOT NULL,
  sealed INTEGER NOT NULL,
  commitment TEXT NOT NULL,
  nonce TEXT NOT NULL,
  orders_json TEXT NOT NULL,
  receipt TEXT
);
CREATE TABLE IF NOT EXISTS votes (
  power TEXT NOT NULL,
  kind TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (power, kind)
);
CREATE TABLE IF NOT EXISTS phase_extensions (
  phase TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS extension_requests (
  phase TEXT NOT NULL,
  power TEXT NOT NULL,
  PRIMARY KEY (phase, power)
);
CREATE TABLE IF NOT EXISTS agent_tokens (
  power TEXT PRIMARY KEY,
  token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS phases (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  results_json TEXT NOT NULL,
  adjudicated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
`;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export class GameRoom extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private meta: Meta | null = null;
  private game: Game | null = null;
  /** Per-socket rate limit buckets. In memory only: hibernation resets them, which is harmless. */
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await engineReady();
      const storedMeta = await ctx.storage.get<Meta>("meta");
      if (storedMeta) {
        this.meta = { ...storedMeta, settings: GameSettings.parse(storedMeta.settings) };
        // Fill settings added after this game was created, while preserving its saved pacing values.
        if (JSON.stringify(this.meta.settings) !== JSON.stringify(storedMeta.settings)) {
          await ctx.storage.put("meta", this.meta);
        }
      } else {
        this.meta = null;
      }
      // Looking up a code that names no game must not write storage; create() lays the schema down.
      if (this.meta) this.sql.exec(SCHEMA);
      const saved = await ctx.storage.get<string>("saved");
      if (saved) this.game = Game.fromSaved(saved, this.meta?.settings.rulebook);
      else if (this.meta) this.game = new Game(this.meta.settings.rulebook);
      if (this.meta && (this.meta.status === "active" || this.meta.status === "paused")) {
        const alarm = await ctx.storage.getAlarm();
        const recovered = recoverSchedule(
          this.meta.status,
          this.meta.pauseReason,
          this.game?.phase() ?? "S1901M",
          this.meta.deadlineAt,
          this.meta.settings,
          Date.now(),
        );
        if (this.meta.status === "active" && this.meta.deadlineAt === null && recovered.deadlineAt !== null) {
          this.meta.deadlineAt = recovered.deadlineAt;
          await ctx.storage.put("meta", this.meta);
        }
        const shouldRepair = this.meta.status === "active"
          ? alarm !== recovered.alarmAt
          : recovered.alarmAt !== null && alarm === null;
        if (shouldRepair && recovered.alarmAt !== null) {
          await ctx.storage.setAlarm(recovered.alarmAt);
        }
      }
      if (this.meta?.status === "finished" && (await ctx.storage.get("d1-outbox")) && env.DB) {
        if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 1);
      }
    });
  }

  // ---------- HTTP entry (called by the router) ----------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "POST" && path === "/create") return this.create(request);
    if (request.method === "POST" && path === "/join") return this.join(request);
    if (request.method === "POST" && path === "/start") return this.start(request);
    if (request.method === "GET" && path === "/summary") {
      if (!this.meta) return bad("no such game", 404);
      return json(this.summary());
    }
    if (request.method === "GET" && path === "/ledger") {
      if (!this.meta) return bad("no such game", 404);
      return json(this.ledger());
    }
    if (request.method === "GET" && path === "/replay") {
      if (!this.game || !this.meta) return bad("no such game", 404);
      return new Response(this.game.toSaved(this.meta.id), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (path === "/ws") return this.openSocket(request);
    return bad("not found", 404);
  }

  private async create(request: Request): Promise<Response> {
    if (this.meta) return bad("game exists", 409);
    this.sql.exec(SCHEMA);
    const body = (await request.json()) as { id: string; name: string; settings?: unknown; serverUrl?: string };
    const rawSettings = (body.settings ?? {}) as Partial<Settings>;
    const pacing = rawSettings.pacing ?? "async";
    const preset = pacing === "live" ? [600, 300] : pacing === "daily" ? [86400, 43200] : [172800, 86400];
    const settings = GameSettings.parse({
      ...rawSettings,
      movementSeconds: rawSettings.movementSeconds ?? preset[0],
      shortPhaseSeconds: rawSettings.shortPhaseSeconds ?? preset[1],
    });
    const creator = POWERS[Math.floor(Math.random() * POWERS.length)] as PowerName;
    this.meta = {
      id: body.id,
      settings,
      status: "lobby",
      createdAt: Date.now(),
      deadlineAt: null,
      creator,
      finished: null,
      pauseReason: null,
      noOrderPhases: 0,
      ...(body.serverUrl ? { serverUrl: body.serverUrl } : {}),
    };
    this.game = new Game(settings.rulebook);
    for (const p of POWERS) {
      this.sql.exec("INSERT INTO seats (power, kind) VALUES (?, 'open')", p);
    }
    const token = mintToken(body.id, creator);
    this.sql.exec(
      "UPDATE seats SET kind = 'human', name = ?, token_hash = ? WHERE power = ?",
      body.name,
      await hashToken(token),
      creator,
    );
    await this.persist();
    return json({ gameId: body.id, token, power: creator });
  }

  private async join(request: Request): Promise<Response> {
    if (!this.meta) return bad("no such game", 404);
    const joiningLobby = this.meta.status === "lobby";
    const body = (await request.json()) as { name: string; power?: PowerName };
    const candidates = this.seats().filter((s) =>
      this.meta!.status === "lobby" ? s.kind === "open" : this.meta!.status === "active" && s.kind === "civil_disorder",
    );
    if (this.meta.status !== "lobby" && this.meta.status !== "active") return bad("game already started", 409);
    const open = candidates;
    if (open.length === 0) return bad("no open seats", 409);
    const chosen =
      (body.power && open.find((s) => s.power === body.power)) ?? open[Math.floor(Math.random() * open.length)];
    if (!chosen) return bad("no open seats", 409);
    const token = mintToken(this.meta.id, chosen.power);
    this.sql.exec(
      "UPDATE seats SET kind = 'human', name = ?, token_hash = ?, missed = 0, ready = 0 WHERE power = ?",
      body.name,
      await hashToken(token),
      chosen.power,
    );
    this.sql.exec("DELETE FROM agent_tokens WHERE power = ?", chosen.power);
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    if (joiningLobby && this.seats().every((s) => s.kind !== "open")) await this.begin();
    return json({ gameId: this.meta.id, token, power: chosen.power });
  }

  /** The creator starts early; open seats become AI seats when `aiFill` is on. */
  private async start(request: Request): Promise<Response> {
    if (!this.meta) return bad("no such game", 404);
    const auth = await this.authorise(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
    if (!auth || auth !== this.meta.creator) return bad("only the creator may start the game", 403);
    if (this.meta.status !== "lobby") return bad("game already started", 409);
    if (!this.meta.settings.aiFill && this.seats().some((s) => s.kind === "open")) {
      return bad("seats are still open", 409);
    }
    this.sql.exec("UPDATE seats SET kind = 'ai', name = 'Automaton' WHERE kind = 'open'");
    await this.begin();
    return json(this.summary());
  }

  private async begin(): Promise<void> {
    if (!this.meta) return;
    this.meta.status = "active";
    await this.ensureAgentTokens();
    await this.scheduleDeadline();
    await this.persist();
    await this.enqueueAgents();
    console.info(JSON.stringify({ event: "game_started", gameId: this.meta!.id, phase: this.game!.phase() }));
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    this.broadcastState();
  }

  private async ensureAgentTokens(): Promise<void> {
    for (const seat of this.seats().filter((row) => row.kind === "ai" && row.eliminated === 0)) {
      const stored = this.sql.exec<{ token: string }>("SELECT token FROM agent_tokens WHERE power = ?", seat.power).toArray()[0];
      const token = stored?.token ?? mintToken(this.meta!.id, seat.power);
      if (!stored) {
        this.sql.exec("INSERT INTO agent_tokens (power, token) VALUES (?, ?)", seat.power, token);
        this.sql.exec("UPDATE seats SET token_hash = ? WHERE power = ?", await hashToken(token), seat.power);
      }
    }
  }

  private async enqueueAgents(): Promise<void> {
    const serverUrl = this.meta?.serverUrl ?? this.env.SERVER_URL;
    if (!this.meta || !this.env.AGENT_QUEUE || !serverUrl) {
      if (this.meta && this.seats().some((seat) => seat.kind === "ai")) {
        console.error(JSON.stringify({ event: "agent_queue_unavailable", gameId: this.meta.id, hasQueue: !!this.env.AGENT_QUEUE, hasServerUrl: !!serverUrl }));
      }
      return;
    }
    await this.ensureAgentTokens();
    for (const seat of this.seats().filter((row) => row.kind === "ai" && row.eliminated === 0)) {
      const token = this.sql.exec<{ token: string }>("SELECT token FROM agent_tokens WHERE power = ?", seat.power).one().token;
      await this.env.AGENT_QUEUE.send({ gameId: this.meta.id, power: seat.power, token, serverUrl });
    }
  }

  private summary() {
    return {
      id: this.meta?.id ?? null,
      settings: this.meta?.settings ?? null,
      status: this.meta?.status ?? "lobby",
      phase: this.game?.phase() ?? null,
      deadlineAt: this.meta?.deadlineAt ?? null,
      seats: this.seatViews(),
      finished: this.meta?.finished ?? null,
      pauseReason: this.meta?.pauseReason ?? null,
    };
  }

  private ledger(): { gameId: string | null; ledger: Record<string, { kept: number; broken: number }> } {
    const ledger: Record<string, { kept: number; broken: number }> = Object.fromEntries(POWERS.map((power) => [power, { kept: 0, broken: 0 }]));
    for (const row of this.sql.exec<{ pledger: string; receipt: string; n: number }>(
      "SELECT pledger, receipt, COUNT(*) AS n FROM pledges WHERE receipt IN ('kept', 'broken') GROUP BY pledger, receipt",
    ).toArray()) {
      if (row.receipt === "kept") ledger[row.pledger]!.kept = row.n;
      else ledger[row.pledger]!.broken = row.n;
    }
    return { gameId: this.meta?.id ?? null, ledger };
  }

  // ---------- seats and auth ----------

  private seats(): SeatRow[] {
    return this.sql.exec<SeatRow>("SELECT * FROM seats ORDER BY power").toArray();
  }

  private seat(power: PowerName): SeatRow | undefined {
    return this.seats().find((s) => s.power === power);
  }

  private seatViews(): SeatView[] {
    return this.seats().map((s) => ({
      power: s.power,
      kind: s.kind,
      name: s.name,
      ready: s.ready === 1,
      eliminated: s.eliminated === 1,
      missed: s.missed,
    }));
  }

  private async authorise(token: string): Promise<PowerName | null> {
    const parsed = parseToken(token);
    if (!parsed || !this.meta || parsed.gameId !== this.meta.id) return null;
    const seat = this.seat(parsed.power as PowerName);
    if (!seat?.token_hash) return null;
    return (await hashToken(token)) === seat.token_hash ? seat.power : null;
  }

  // ---------- WebSockets ----------

  private async openSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return bad("expected websocket", 426);
    if (!this.meta || !this.game) return bad("no such game", 404);
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const power = token ? await this.authorise(token) : null;
    if (token && !power) return bad("bad token", 401);
    if (!power && this.ctx.getWebSockets("spectator").length >= LIMITS.spectators) {
      return bad("too many spectators", 503);
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [power ?? "spectator"]);
    server.serializeAttachment({ power, clientIp: request.headers.get("cf-connecting-ip") } satisfies Attachment);
    if (power && this.meta.status === "paused" && this.meta.pauseReason === "humans_absent") {
      this.meta.status = "active";
      this.meta.pauseReason = null;
      await this.scheduleDeadline();
      await this.persist();
      this.broadcast({ t: "status", p: { status: "active", reason: null } }, "ALL");
      this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
      this.broadcastState();
    }
    this.send(server, { t: "welcome", p: this.welcome(power) });
    return new Response(null, { status: 101, webSocket: client });
  }

  private welcome(power: PowerName | null): Extract<ServerMessage, { t: "welcome" }>["p"] {
    const meta = this.meta!;
    const game = this.game!;
    const phase = game.phase();
    const orders = power
      ? this.sql
          .exec<{ orders_json: string }>("SELECT orders_json FROM orders WHERE phase = ? AND power = ?", phase, power)
          .toArray()
          .map((r) => JSON.parse(r.orders_json) as string[])[0] ?? []
      : [];
    return {
      gameId: meta.id,
      settings: meta.settings,
      status: meta.status,
      pauseReason: meta.pauseReason ?? null,
      power,
      phase,
      state: game.state() as StateView,
      seats: this.seatViews(),
      deadlineAt: meta.deadlineAt,
      seq: this.lastSeq(),
      orders,
      press: this.pressFor(power),
    };
  }

  /** Spend one token from the socket's bucket; false when it is empty. */
  private allow(ws: WebSocket): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ws) ?? { tokens: LIMITS.burst, at: now };
    bucket.tokens = Math.min(LIMITS.burst, bucket.tokens + ((now - bucket.at) / 1000) * LIMITS.refillPerSecond);
    bucket.at = now;
    const ok = bucket.tokens >= 1;
    if (ok) bucket.tokens -= 1;
    this.buckets.set(ws, bucket);
    return ok;
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const byteLength = typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
    if (byteLength > 4096) {
      return this.send(ws, { t: "error", p: { code: "too_large", message: "frame exceeds 4 KB" } });
    }
    if (typeof raw !== "string") return;
    if (!this.allow(ws)) {
      return this.send(ws, { t: "error", p: { code: "rate_limited", message: "slow down" } });
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return this.send(ws, { t: "error", p: { code: "bad_json", message: "frame is not JSON" } });
    }
    const msg = parseClientMessage(data);
    if (!msg) return this.send(ws, { t: "error", p: { code: "bad_frame", message: "frame did not validate" } });
    const { power } = ws.deserializeAttachment() as Attachment;
    const id = "id" in msg ? msg.id : undefined;
    if (msg.t === "hello") return; // identity is bound at connect time
    if (msg.t === "sync") {
      for (const ev of this.eventsSince(msg.p.since, power)) ws.send(ev);
      return;
    }
    if (!power) return this.send(ws, { t: "error", id, p: { code: "spectator", message: "spectators cannot act" } });
    if (!this.meta || !this.game || this.meta.status !== "active") {
      return this.send(ws, { t: "error", id, p: { code: "not_active", message: "the game is not active" } });
    }
    switch (msg.t) {
      case "orders.set":
        return this.setOrders(ws, id, power, msg.p.phase, msg.p.orders);
      case "orders.default":
        return this.setDefaults(ws, id, power, msg.p.orders);
      case "ready":
        return this.setReady(power, msg.p.phase, msg.p.ready);
      case "extend":
        return this.requestExtension(ws, id, power, msg.p.phase);
      case "press.send":
        return this.press(ws, id, power, msg.p.to, msg.p.body, msg.p.pledge);
      case "vote":
        return this.vote(power, msg.p.value);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
    await this.updateHumanPresence();
  }

  override async webSocketError(_ws: WebSocket): Promise<void> {
    await this.updateHumanPresence();
  }

  private async updateHumanPresence(): Promise<void> {
    if (!this.meta || this.meta.status !== "active") return;
    const connectedHumanPowers = new Set(
      this.ctx.getWebSockets()
        .filter((socket) => socket.readyState === WebSocket.OPEN)
        .map((socket) => (socket.deserializeAttachment() as Attachment).power)
        .filter((power): power is PowerName => !!power && this.seat(power)?.kind === "human"),
    );
    const activeHumans = this.seats().filter((seat) => seat.kind === "human" && seat.eliminated === 0);
    if (activeHumans.length > 0 && activeHumans.every((seat) => !connectedHumanPowers.has(seat.power))) {
      this.meta.status = "paused";
      this.meta.pauseReason = "humans_absent";
      this.meta.deadlineAt = null;
      await this.ctx.storage.deleteAlarm();
      await this.persist();
      this.broadcast({ t: "status", p: { status: "paused", reason: "humans_absent" } }, "ALL");
      this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
      this.broadcastState();
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // socket already gone; hibernation will clean it up
    }
  }

  /** Broadcast to a power, to `ALL`, and always to spectators when the audience is `ALL`. */
  private broadcast(message: ServerMessage, audience: PowerName | "ALL"): void {
    const payload = JSON.stringify(message);
    this.sql.exec("INSERT INTO events (audience, payload_json) VALUES (?, ?)", audience, payload);
    const sockets =
      audience === "ALL" ? this.ctx.getWebSockets() : this.ctx.getWebSockets(audience);
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // ignore dead sockets
      }
    }
  }

  private lastSeq(): number {
    return this.sql.exec<{ n: number | null }>("SELECT MAX(seq) AS n FROM events").one().n ?? 0;
  }

  private eventsSince(since: number, power: PowerName | null): string[] {
    return this.sql
      .exec<{ payload_json: string }>(
        "SELECT payload_json FROM events WHERE seq > ? AND (audience = 'ALL' OR audience = ?) ORDER BY seq LIMIT ?",
        since,
        power ?? "ALL",
        LIMITS.syncPage,
      )
      .toArray()
      .map((e) => e.payload_json);
  }

  private broadcastState(): void {
    if (!this.game || !this.meta) return;
    this.broadcast(
      {
        t: "state",
        p: { phase: this.game.phase(), state: this.game.state() as StateView, deadlineAt: this.meta.deadlineAt, seq: this.lastSeq() },
      },
      "ALL",
    );
  }

  // ---------- orders ----------

  private phaseKind(): "M" | "R" | "A" {
    const phase = this.game?.phase() ?? "S1901M";
    const k = phase.at(-1);
    return k === "R" ? "R" : k === "A" ? "A" : "M";
  }

  private canonicalOwnOrder(text: string, kind: "M" | "R" | "A", power: PowerName): string {
    const explicitPower = /^([A-Z]+):/.exec(text.trim().toUpperCase())?.[1];
    const explicitOwner: Partial<Record<string, PowerName>> = {
      AUS: "AUSTRIA", AUSTRIA: "AUSTRIA",
      ENG: "ENGLAND", ENGLAND: "ENGLAND",
      FRA: "FRANCE", FRANCE: "FRANCE",
      GER: "GERMANY", GERMANY: "GERMANY",
      ITA: "ITALY", ITALY: "ITALY",
      RUS: "RUSSIA", RUSSIA: "RUSSIA",
      TUR: "TURKEY", TURKEY: "TURKEY",
    };
    if (explicitPower && explicitOwner[explicitPower] !== power) throw new Error("order names another power");
    const canonical = canonicalOrder(text, kind, power);
    return canonical;
  }

  private setOrders(ws: WebSocket, id: string | undefined, power: PowerName, phase: string, orders: string[]): void {
    const game = this.game!;
    const seat = this.seat(power);
    if (!seat || seat.eliminated === 1) {
      return this.send(ws, { t: "error", id, p: { code: "seat_inactive", message: "this seat cannot submit orders" } });
    }
    if (phase !== game.phase()) {
      return this.send(ws, { t: "error", id, p: { code: "stale_phase", message: `current phase is ${game.phase()}` } });
    }
    const accepted: string[] = [];
    const rejected: { text: string; reason: string }[] = [];
    const kind = this.phaseKind();
    for (const text of orders) {
      try {
        accepted.push(this.canonicalOwnOrder(text, kind, power));
      } catch (e) {
        rejected.push({ text, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    this.sql.exec(
      "INSERT INTO orders (phase, power, orders_json, submitted_at) VALUES (?, ?, ?, ?) ON CONFLICT(phase, power) DO UPDATE SET orders_json = excluded.orders_json, submitted_at = excluded.submitted_at",
      phase,
      power,
      JSON.stringify(accepted),
      Date.now(),
    );
    if (seat.kind === "civil_disorder") {
      this.sql.exec("UPDATE seats SET kind = 'human', missed = 0 WHERE power = ?", power);
    }
    this.send(ws, { t: "orders.ack", id, p: { phase, accepted, rejected } });
  }

  /** Standing movement orders used when a power submits nothing. They are canonicalised under the
   * sender's own power, so a prefix naming another power can never be stored. */
  private setDefaults(ws: WebSocket, id: string | undefined, power: PowerName, orders: string[]): void {
    const accepted: string[] = [];
    const rejected: { text: string; reason: string }[] = [];
    for (const text of orders) {
      try {
        accepted.push(this.canonicalOwnOrder(text, "M", power));
      } catch (e) {
        rejected.push({ text, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    this.sql.exec(
      "INSERT INTO defaults (power, orders_json) VALUES (?, ?) ON CONFLICT(power) DO UPDATE SET orders_json = excluded.orders_json",
      power,
      JSON.stringify(accepted),
    );
    if (rejected.length > 0) {
      const detail = rejected.map((r) => `${r.text}: ${r.reason}`).join("; ");
      this.send(ws, { t: "error", id, p: { code: "bad_order", message: `default orders rejected: ${detail}` } });
    }
  }

  private async setReady(power: PowerName, phase: string, ready: boolean): Promise<void> {
    if (phase !== this.game!.phase()) return;
    if (this.seat(power)?.ready === (ready ? 1 : 0)) return; // unchanged: no write, no broadcast
    this.sql.exec("UPDATE seats SET ready = ? WHERE power = ?", ready ? 1 : 0, power);
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    const waiting = this.seats().filter((s) => s.kind === "human" && s.eliminated === 0 && s.ready === 0);
    if (this.meta?.settings.readyAdvance && waiting.length === 0) await this.adjudicate();
  }

  private async requestExtension(ws: WebSocket, id: string | undefined, power: PowerName, phase: string): Promise<void> {
    if (phase !== this.game!.phase()) {
      return this.send(ws, { t: "error", id, p: { code: "stale_phase", message: `current phase is ${this.game!.phase()}` } });
    }
    this.sql.exec("INSERT OR IGNORE INTO phase_extensions (phase, used) VALUES (?, 0)", phase);
    const used = this.sql.exec<{ used: number }>("SELECT used FROM phase_extensions WHERE phase = ?", phase).one().used;
    if (used) return this.send(ws, { t: "error", id, p: { code: "extension_used", message: "this phase was already extended" } });
    this.sql.exec("INSERT OR IGNORE INTO extension_requests (phase, power) VALUES (?, ?)", phase, power);
    const requests = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM extension_requests WHERE phase = ?", phase).one().n;
    const extended = requests >= 2;
    if (extended) {
      this.sql.exec("UPDATE phase_extensions SET used = 1 WHERE phase = ?", phase);
      this.meta!.deadlineAt = Math.max(Date.now(), this.meta!.deadlineAt ?? Date.now()) + this.meta!.settings.graceSeconds * 1000;
      await this.ctx.storage.setAlarm(this.meta!.deadlineAt);
      await this.persist();
      this.broadcast({ t: "deadline", p: { phase, deadlineAt: this.meta!.deadlineAt } }, "ALL");
    }
    this.send(ws, { t: "extend.ack", id, p: { phase, requests, extended } });
  }

  // ---------- press and pledges ----------

  private pressFor(power: PowerName | null): PressView[] {
    // The most recent messages this viewer may read, oldest first.
    const rows = this.sql
      .exec<{ id: string; phase: string; sender: string; recipient: string; body: string; sent_at: number; pledge_id: string | null }>(
        `SELECT * FROM (
           SELECT * FROM press WHERE recipient = 'ALL' OR sender = ? OR recipient = ?
           ORDER BY sent_at DESC LIMIT ?
         ) ORDER BY sent_at`,
        power ?? "",
        power ?? "",
        LIMITS.welcomePress,
      )
      .toArray();
    return rows.map((r) => ({
        id: r.id,
        phase: r.phase,
        from: r.sender as PowerName,
        to: r.recipient as PowerName | "ALL",
        body: r.body,
        sentAt: r.sent_at,
        pledge: r.pledge_id ? this.pledgeView(r.pledge_id, power) : null,
      }));
  }

  private pledgeView(id: string, viewer: PowerName | null): PledgeView | null {
    const row = this.sql
      .exec<{ id: string; pledger: string; audience: string; phase: string; sealed: number; commitment: string; orders_json: string; receipt: string | null }>(
        "SELECT * FROM pledges WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row) return null;
    const revealed = row.receipt !== null || row.sealed === 0 || viewer === row.pledger;
    return {
      id: row.id,
      pledger: row.pledger as PowerName,
      audience: row.audience as PowerName | "ALL",
      phase: row.phase,
      sealed: row.sealed === 1,
      commitment: row.commitment,
      orders: revealed ? (JSON.parse(row.orders_json) as string[]) : null,
      receipt: (row.receipt as PledgeView["receipt"]) ?? null,
    };
  }

  private async press(
    ws: WebSocket,
    id: string | undefined,
    from: PowerName,
    to: PowerName | "ALL",
    body: string,
    pledge: { orders: string[]; sealed: boolean; nonce?: string | undefined } | undefined,
  ): Promise<void> {
    const mode = this.meta!.settings.press;
    const phaseKind = this.phaseKind();
    if (phaseKind === "R" || phaseKind === "A") {
      return this.send(ws, {
        t: "error",
        id,
        p: {
          code: "press_closed",
          message: "press is unavailable during retreat and adjustment phases",
        },
      });
    }
    if (mode === "gunboat") return this.send(ws, { t: "error", id, p: { code: "no_press", message: "gunboat: no press" } });
    if (mode === "public" && to !== "ALL") {
      return this.send(ws, { t: "error", id, p: { code: "public_only", message: "public press only" } });
    }
    const phase = this.game!.phase();
    const sent = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM press WHERE sender = ? AND phase = ?", from, phase)
      .one().n;
    if (sent >= LIMITS.pressPerPhase) {
      return this.send(ws, { t: "error", id, p: { code: "press_limit", message: `at most ${LIMITS.pressPerPhase} messages per phase` } });
    }
    if (to !== "ALL") {
      const whispers = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM press WHERE sender = ? AND phase = ? AND recipient <> 'ALL'", from, phase)
        .one().n;
      if (whispers >= this.meta!.settings.whisperBudget) {
        return this.send(ws, { t: "error", id, p: { code: "whisper_budget", message: `at most ${this.meta!.settings.whisperBudget} private messages per phase` } });
      }
    }
    if (this.env.PRESS_LIMITER) {
      const { clientIp } = ws.deserializeAttachment() as Attachment;
      const { success } = await this.env.PRESS_LIMITER.limit({ key: clientIp ?? `${this.meta!.id}:${from}` });
      if (!success) return this.send(ws, { t: "error", id, p: { code: "press_rate_limited", message: "too many press messages, try again later" } });
    }
    let pledgeId: string | null = null;
    if (pledge) {
      const kind = this.phaseKind();
      let canonical: string[];
      try {
        canonical = pledge.orders.map((o) => this.canonicalOwnOrder(o, kind, from));
      } catch (e) {
        return this.send(ws, { t: "error", id, p: { code: "bad_pledge", message: e instanceof Error ? e.message : String(e) } });
      }
      const nonce = pledge.nonce ?? randomNonce();
      pledgeId = randomId(8);
      this.sql.exec(
        "INSERT INTO pledges (id, pledger, audience, phase, sealed, commitment, nonce, orders_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        pledgeId,
        from,
        to,
        phase,
        pledge.sealed ? 1 : 0,
        pledgeCommit(canonical, nonce),
        nonce,
        JSON.stringify(canonical),
      );
    }
    const pressId = randomId(8);
    const sentAt = Date.now();
    this.sql.exec(
      "INSERT INTO press (id, phase, sender, recipient, body, sent_at, pledge_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      pressId,
      phase,
      from,
      to,
      body,
      sentAt,
      pledgeId,
    );
    const view = (viewer: PowerName | null): PressView => ({
      id: pressId,
      phase,
      from,
      to,
      body,
      sentAt,
      pledge: pledgeId ? this.pledgeView(pledgeId, viewer) : null,
    });
    if (to === "ALL") {
      // sealed content differs per viewer only for the pledger
      for (const ws2 of this.ctx.getWebSockets()) {
        const { power } = ws2.deserializeAttachment() as Attachment;
        this.send(ws2, { t: "press", id: ws2 === ws ? id : undefined, p: view(power) });
      }
      this.sql.exec("INSERT INTO events (audience, payload_json) VALUES ('ALL', ?)", JSON.stringify({ t: "press", p: view(null) }));
    } else {
      this.broadcast({ t: "press", p: view(to) }, to);
      this.broadcast({ t: "press", id, p: view(from) }, from);
    }
  }

  private async vote(power: PowerName, value: boolean): Promise<void> {
    this.sql.exec(
      "INSERT INTO votes (power, kind, value) VALUES (?, 'draw', ?) ON CONFLICT(power, kind) DO UPDATE SET value = excluded.value",
      power,
      value ? 1 : 0,
    );
    const voters = this.seats().filter((s) => this.meta!.settings.ghostVotes || s.eliminated === 0);
    const yes = new Set(
      this.sql.exec<{ power: string }>("SELECT power FROM votes WHERE kind = 'draw' AND value = 1").toArray().map((r) => r.power),
    );
    // AI and civil-disorder seats abstain; active players follow DIAS or non-DIAS rules.
    const absent = (s: SeatRow) => s.kind === "ai" || s.kind === "civil_disorder";
    const required = voters.filter((s) => !absent(s));
    const passed = this.meta!.settings.dias
      ? required.every((seat) => yes.has(seat.power))
      : required.filter((seat) => yes.has(seat.power)).length >= 2;
    if (passed) await this.finish("draw");
  }

  // ---------- deadlines and adjudication ----------

  private async scheduleDeadline(): Promise<void> {
    if (!this.meta || !this.game) return;
    const seconds = this.phaseKind() === "M" ? this.meta.settings.movementSeconds : this.meta.settings.shortPhaseSeconds;
    this.meta.deadlineAt = Date.now() + (seconds + this.meta.settings.graceSeconds) * 1000;
    await this.ctx.storage.setAlarm(this.meta.deadlineAt);
    this.broadcast({ t: "deadline", p: { phase: this.game.phase(), deadlineAt: this.meta.deadlineAt } }, "ALL");
  }

  override async alarm(): Promise<void> {
    if (this.meta?.status === "active") {
      if (this.meta.deadlineAt !== null && Date.now() < this.meta.deadlineAt) {
        await this.ctx.storage.setAlarm(this.meta.deadlineAt);
        return;
      }
      await this.adjudicate();
    } else if (this.meta?.status === "paused" && this.meta.pauseReason === "adjudication_failed") {
      await this.adjudicate();
    } else if (this.meta?.status === "finished") {
      await this.flushD1Summary();
    }
  }

  private ordersFor(phase: string, power: PowerName): { orders: string[]; submitted: boolean } {
    const row = this.sql.exec<{ orders_json: string }>("SELECT orders_json FROM orders WHERE phase = ? AND power = ?", phase, power).toArray()[0];
    if (row) return { orders: this.parseOrderList(row.orders_json), submitted: true };
    // Defaults are movement orders; retreats and adjustments fall back to the engine's own rules.
    const def =
      this.phaseKind() === "M"
        ? this.sql.exec<{ orders_json: string }>("SELECT orders_json FROM defaults WHERE power = ?", power).toArray()[0]
        : undefined;
    if (def) return { orders: this.parseOrderList(def.orders_json), submitted: false };
    return { orders: [], submitted: false };
  }

  private parseOrderList(raw: string): string[] {
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  private async adjudicate(): Promise<void> {
    const game = this.game!;
    const phase = game.phase();
    const kind = this.phaseKind();
    const orders: Record<string, string[]> = {};
    const submittedBy: Record<string, string[]> = {};
    const seats = this.seats();
    const submittedSeats = new Set<string>();
    for (const seat of seats) {
      const { orders: stored, submitted } = this.ordersFor(phase, seat.power);
      if (submitted) submittedSeats.add(seat.power);
      // Re-validate every stored order on its own: one bad row must never stop the phase.
      const valid: string[] = [];
      for (const text of stored) {
        try {
          valid.push(this.canonicalOwnOrder(text, kind, seat.power));
        } catch {
          // dropped; the unit is treated as unordered
        }
      }
      orders[seat.power] = valid;
      submittedBy[seat.power] = valid;
    }
    const savedBeforeAdjudication = game.toSaved(this.meta!.id);
    const recovering = this.meta!.status === "paused";
    let outcome: ReturnType<Game["process"]>;
    try {
      outcome = adjudicateStrict(game, { orders }, (e) =>
        console.error(JSON.stringify({ event: "adjudicate_failed", phase, error: String(e) })),
      );
    } catch (error) {
      // `process` may mutate before throwing. Restore the durable snapshot so retrying
      // can never apply a partially adjudicated phase a second time.
      this.game = Game.fromSaved(savedBeforeAdjudication, this.meta!.settings.rulebook);
      this.meta!.status = "paused";
      this.meta!.deadlineAt = null;
      this.meta!.pauseReason = "adjudication_failed";
      await this.ctx.storage.setAlarm(Date.now() + ADJUDICATION_RETRY_MS);
      await this.persist();
      this.broadcast({ t: "status", p: { status: "paused", reason: "adjudication_failed" } }, "ALL");
      this.broadcast({ t: "deadline", p: { phase, deadlineAt: null } }, "ALL");
      this.broadcast({ t: "error", p: { code: "adjudication_failed", message: "The phase could not be adjudicated. The server will retry automatically." } }, "ALL");
      console.error(JSON.stringify({ event: "adjudicate_retry_scheduled", phase, error: String(error) }));
      return;
    }
    this.meta!.status = "active";
    this.meta!.pauseReason = null;
    for (const seat of seats) {
      if ((seat.kind === "human" || seat.kind === "civil_disorder") && seat.eliminated === 0 && kind === "M") {
        const missed = submittedSeats.has(seat.power) ? 0 : seat.missed + 1;
        const nextKind = missed >= 3 && this.meta!.settings.aiFill ? "ai" : missed >= 2 ? "civil_disorder" : "human";
        this.sql.exec("UPDATE seats SET missed = ?, kind = ? WHERE power = ?", missed, nextKind, seat.power);
        if (nextKind === "ai") {
          const token = mintToken(this.meta!.id, seat.power);
          this.sql.exec("INSERT OR REPLACE INTO agent_tokens (power, token) VALUES (?, ?)", seat.power, token);
          this.sql.exec("UPDATE seats SET token_hash = ?, name = 'Automaton' WHERE power = ?", await hashToken(token), seat.power);
        }
      }
    }
    const phaseHadOrders = Object.values(submittedBy).some((powerOrders) => powerOrders.length > 0);
    this.meta!.noOrderPhases = phaseHadOrders ? 0 : (this.meta!.noOrderPhases ?? 0) + 1;
    this.sql.exec("INSERT INTO phases (name, results_json, adjudicated_at) VALUES (?, ?, ?)", phase, JSON.stringify(outcome), Date.now());
    console.info(JSON.stringify({ event: "phase_adjudicated", gameId: this.meta!.id, phase, nextPhase: this.game!.phase() }));

    // receipts for every pledge made in this phase
    const pledges = this.sql
      .exec<{ id: string; pledger: string; audience: string; sealed: number; orders_json: string }>(
        "SELECT id, pledger, audience, sealed, orders_json FROM pledges WHERE phase = ? AND receipt IS NULL",
        phase,
      )
      .toArray();
    for (const p of pledges) {
      const pledged = JSON.parse(p.orders_json) as string[];
      const receipt = pledgeReceipt(pledged, submittedBy[p.pledger] ?? []);
      this.sql.exec("UPDATE pledges SET receipt = ? WHERE id = ?", receipt, p.id);
      const frame: ServerMessage = { t: "pledge.receipt", p: { pledgeId: p.id, receipt, revealed: pledged } };
      if (p.audience === "ALL") this.broadcast(frame, "ALL");
      else {
        this.broadcast(frame, p.audience as PowerName);
        this.broadcast(frame, p.pledger as PowerName);
      }
    }

    // eliminations and ready flags
    const next = outcome.next;
    for (const seat of this.seats()) {
      const units = next.units[seat.power]?.length ?? 0;
      const centers = next.centers[seat.power]?.length ?? 0;
      this.sql.exec("UPDATE seats SET ready = 0, eliminated = ? WHERE power = ?", units === 0 && centers === 0 ? 1 : 0, seat.power);
    }

    this.broadcast(
      {
        t: "results",
        p: {
          phase,
          results: outcome.results as OrderResultView[],
          dislodged: outcome.dislodged,
          standoffs: outcome.standoffs,
          civil_disorder: outcome.civil_disorder,
          seq: this.lastSeq(),
        },
      },
      "ALL",
    );
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");

    if ((this.meta!.noOrderPhases ?? 0) >= 3) {
      this.meta!.status = "abandoned";
      this.meta!.deadlineAt = null;
      await this.ctx.storage.deleteAlarm();
      await this.persist();
      this.broadcast({ t: "status", p: { status: "abandoned", reason: "no_orders" } }, "ALL");
      this.broadcastState();
      return;
    }

    if (outcome.status !== "active") {
      const winner = outcome.status.startsWith("solo:") ? (outcome.status.slice(5) as PowerName) : null;
      await this.finish(winner ? "solo" : "draw", winner);
      return;
    }
    await this.scheduleDeadline();
    await this.persist();
    await this.enqueueAgents();
    if (recovering) this.broadcast({ t: "status", p: { status: "active", reason: null } }, "ALL");
    this.broadcastState();
  }

  private async finish(result: "solo" | "draw", winner: PowerName | null = null): Promise<void> {
    const game = this.game!;
    const meta = this.meta!;
    if (result === "draw") game.declareDraw();
    const centers: Record<string, number> = {};
    const state = game.state();
    for (const p of POWERS) centers[p] = state.centers[p]?.length ?? 0;
    const scores = winner ? Object.fromEntries(POWERS.map((p) => [p, p === winner ? 1 : 0])) : sumOfSquares(centers);
    const winners = winner ? [winner] : (POWERS.filter((p) => centers[p]! > 0) as PowerName[]);
    meta.status = "finished";
    meta.deadlineAt = null;
    meta.pauseReason = null;
    meta.finished = { result, winners, scores };
    console.info(JSON.stringify({ event: "game_finished", gameId: meta.id, result, winners }));
    const phaseCount = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM phases").one().n;
    await this.ctx.storage.put("d1-outbox", {
      gameId: meta.id,
      result,
      winners,
      scores,
      settings: meta.settings,
      phaseCount,
      finishedAt: Date.now(),
      ledger: this.ledger().ledger,
    });
    await this.ctx.storage.deleteAlarm();
    await this.persist();
    await this.flushD1Summary();
    this.broadcast({ t: "status", p: { status: "finished", reason: null } }, "ALL");
    this.broadcast({ t: "finished", p: { result, winners, scores } }, "ALL");
    this.broadcastState();
  }

  private async flushD1Summary(): Promise<void> {
    const summary = await this.ctx.storage.get<{
      gameId: string;
      result: string;
      winners: string[];
      scores: Record<string, number>;
      settings: Settings;
      phaseCount: number;
      finishedAt: number;
      ledger: Record<string, { kept: number; broken: number }>;
    }>("d1-outbox");
    if (!summary || !this.env.DB) return;
    try {
      await this.env.DB.prepare(
        `INSERT INTO games_index (game_id, result, winners_json, scores_json, settings_json, phase_count, finished_at, ledger_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id) DO UPDATE SET result = excluded.result, winners_json = excluded.winners_json,
         scores_json = excluded.scores_json, settings_json = excluded.settings_json,
         phase_count = excluded.phase_count, finished_at = excluded.finished_at, ledger_json = excluded.ledger_json`,
      ).bind(
        summary.gameId,
        summary.result,
        JSON.stringify(summary.winners),
        JSON.stringify(summary.scores),
        JSON.stringify(summary.settings),
        summary.phaseCount,
        summary.finishedAt,
        JSON.stringify(summary.ledger),
      ).run();
      await this.ctx.storage.delete("d1-outbox");
      await this.ctx.storage.deleteAlarm();
    } catch (error) {
      console.error(JSON.stringify({ event: "d1_handoff_failed", gameId: summary.gameId, error: String(error) }));
      await this.ctx.storage.setAlarm(Date.now() + ADJUDICATION_RETRY_MS);
    }
  }

  private async persist(): Promise<void> {
    if (!this.meta || !this.game) return;
    await this.ctx.storage.put("meta", this.meta);
    await this.ctx.storage.put("saved", this.game.toSaved(this.meta.id));
  }
}

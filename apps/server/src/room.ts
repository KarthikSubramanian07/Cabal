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

type Status = "lobby" | "active" | "finished";

interface Meta {
  id: string;
  settings: Settings;
  status: Status;
  createdAt: number;
  deadlineAt: number | null;
  creator: PowerName;
  finished: { result: "solo" | "draw"; winners: PowerName[]; scores: Record<string, number> } | null;
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await engineReady();
      this.sql.exec(SCHEMA);
      this.meta = (await ctx.storage.get<Meta>("meta")) ?? null;
      const saved = await ctx.storage.get<string>("saved");
      if (saved) this.game = Game.fromSaved(saved, this.meta?.settings.rulebook);
      else if (this.meta) this.game = new Game(this.meta.settings.rulebook);
    });
  }

  // ---------- HTTP entry (called by the router) ----------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "POST" && path === "/create") return this.create(request);
    if (request.method === "POST" && path === "/join") return this.join(request);
    if (request.method === "POST" && path === "/start") return this.start(request);
    if (request.method === "GET" && path === "/summary") return json(this.summary());
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
    const body = (await request.json()) as { id: string; name: string; settings?: unknown };
    const settings = GameSettings.parse(body.settings ?? {});
    const creator = POWERS[Math.floor(Math.random() * POWERS.length)] as PowerName;
    this.meta = {
      id: body.id,
      settings,
      status: "lobby",
      createdAt: Date.now(),
      deadlineAt: null,
      creator,
      finished: null,
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
    if (this.meta.status !== "lobby") return bad("game already started", 409);
    const body = (await request.json()) as { name: string; power?: PowerName };
    const open = this.seats().filter((s) => s.kind === "open");
    if (open.length === 0) return bad("no open seats", 409);
    const chosen =
      (body.power && open.find((s) => s.power === body.power)) ?? open[Math.floor(Math.random() * open.length)];
    if (!chosen) return bad("no open seats", 409);
    const token = mintToken(this.meta.id, chosen.power);
    this.sql.exec(
      "UPDATE seats SET kind = 'human', name = ?, token_hash = ? WHERE power = ?",
      body.name,
      await hashToken(token),
      chosen.power,
    );
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    if (this.seats().every((s) => s.kind !== "open")) await this.begin();
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
    await this.scheduleDeadline();
    await this.persist();
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    this.broadcastState();
  }

  private summary() {
    return {
      id: this.meta?.id ?? null,
      settings: this.meta?.settings ?? null,
      status: this.meta?.status ?? "missing",
      phase: this.game?.phase() ?? null,
      deadlineAt: this.meta?.deadlineAt ?? null,
      seats: this.seatViews(),
      finished: this.meta?.finished ?? null,
    };
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
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [power ?? "spectator"]);
    server.serializeAttachment({ power } satisfies Attachment);
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

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
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
        this.sql.exec(
          "INSERT INTO defaults (power, orders_json) VALUES (?, ?) ON CONFLICT(power) DO UPDATE SET orders_json = excluded.orders_json",
          power,
          JSON.stringify(msg.p.orders),
        );
        return;
      case "ready":
        return this.setReady(power, msg.p.phase, msg.p.ready);
      case "press.send":
        return this.press(ws, id, power, msg.p.to, msg.p.body, msg.p.pledge);
      case "vote":
        return this.vote(power, msg.p.value);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
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
      .exec<{ audience: string; payload_json: string }>("SELECT audience, payload_json FROM events WHERE seq > ? ORDER BY seq", since)
      .toArray()
      .filter((e) => e.audience === "ALL" || e.audience === power)
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

  private setOrders(ws: WebSocket, id: string | undefined, power: PowerName, phase: string, orders: string[]): void {
    const game = this.game!;
    if (phase !== game.phase()) {
      return this.send(ws, { t: "error", id, p: { code: "stale_phase", message: `current phase is ${game.phase()}` } });
    }
    const accepted: string[] = [];
    const rejected: { text: string; reason: string }[] = [];
    const kind = this.phaseKind();
    for (const text of orders) {
      try {
        accepted.push(canonicalOrder(text, kind, power));
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
    this.send(ws, { t: "orders.ack", id, p: { phase, accepted, rejected } });
  }

  private async setReady(power: PowerName, phase: string, ready: boolean): Promise<void> {
    if (phase !== this.game!.phase()) return;
    this.sql.exec("UPDATE seats SET ready = ? WHERE power = ?", ready ? 1 : 0, power);
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    const waiting = this.seats().filter((s) => s.kind === "human" && s.eliminated === 0 && s.ready === 0);
    if (this.meta?.settings.readyAdvance && waiting.length === 0) await this.adjudicate();
  }

  // ---------- press and pledges ----------

  private pressFor(power: PowerName | null): PressView[] {
    const rows = this.sql
      .exec<{ id: string; phase: string; sender: string; recipient: string; body: string; sent_at: number; pledge_id: string | null }>(
        "SELECT * FROM press ORDER BY sent_at",
      )
      .toArray();
    return rows
      .filter((r) => r.recipient === "ALL" || r.sender === power || r.recipient === power)
      .map((r) => ({
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

  private press(
    ws: WebSocket,
    id: string | undefined,
    from: PowerName,
    to: PowerName | "ALL",
    body: string,
    pledge: { orders: string[]; sealed: boolean; nonce?: string | undefined } | undefined,
  ): void {
    const mode = this.meta!.settings.press;
    if (mode === "gunboat") return this.send(ws, { t: "error", id, p: { code: "no_press", message: "gunboat: no press" } });
    if (mode === "public" && to !== "ALL") {
      return this.send(ws, { t: "error", id, p: { code: "public_only", message: "public press only" } });
    }
    const phase = this.game!.phase();
    let pledgeId: string | null = null;
    if (pledge) {
      const kind = this.phaseKind();
      let canonical: string[];
      try {
        canonical = pledge.orders.map((o) => canonicalOrder(o, kind, from));
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
    if (voters.every((s) => yes.has(s.power) || s.kind === "ai")) await this.finish("draw");
  }

  // ---------- deadlines and adjudication ----------

  private async scheduleDeadline(): Promise<void> {
    if (!this.meta || !this.game) return;
    const seconds = this.phaseKind() === "M" ? this.meta.settings.movementSeconds : this.meta.settings.shortPhaseSeconds;
    this.meta.deadlineAt = Date.now() + seconds * 1000;
    await this.ctx.storage.setAlarm(this.meta.deadlineAt);
    this.broadcast({ t: "deadline", p: { phase: this.game.phase(), deadlineAt: this.meta.deadlineAt } }, "ALL");
  }

  override async alarm(): Promise<void> {
    if (this.meta?.status === "active") await this.adjudicate();
  }

  private ordersFor(phase: string, power: PowerName): { orders: string[]; submitted: boolean } {
    const row = this.sql.exec<{ orders_json: string }>("SELECT orders_json FROM orders WHERE phase = ? AND power = ?", phase, power).toArray()[0];
    if (row) return { orders: JSON.parse(row.orders_json) as string[], submitted: true };
    const def = this.sql.exec<{ orders_json: string }>("SELECT orders_json FROM defaults WHERE power = ?", power).toArray()[0];
    if (def) return { orders: JSON.parse(def.orders_json) as string[], submitted: false };
    return { orders: [], submitted: false };
  }

  private async adjudicate(): Promise<void> {
    const game = this.game!;
    const phase = game.phase();
    const orders: Record<string, string[]> = {};
    const submittedBy: Record<string, string[]> = {};
    for (const seat of this.seats()) {
      const { orders: o, submitted } = this.ordersFor(phase, seat.power);
      orders[seat.power] = o;
      submittedBy[seat.power] = o;
      if (seat.kind === "human" && seat.eliminated === 0 && this.phaseKind() === "M") {
        const missed = submitted ? 0 : seat.missed + 1;
        const kind = missed >= 2 ? "civil_disorder" : "human";
        this.sql.exec("UPDATE seats SET missed = ?, kind = ? WHERE power = ?", missed, kind, seat.power);
      }
    }
    const outcome = game.process({ orders });
    this.sql.exec("INSERT INTO phases (name, results_json, adjudicated_at) VALUES (?, ?, ?)", phase, JSON.stringify(outcome), Date.now());

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

    if (outcome.status !== "active") {
      const winner = outcome.status.startsWith("solo:") ? (outcome.status.slice(5) as PowerName) : null;
      await this.finish(winner ? "solo" : "draw", winner);
      return;
    }
    await this.scheduleDeadline();
    await this.persist();
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
    meta.finished = { result, winners, scores };
    await this.ctx.storage.deleteAlarm();
    await this.persist();
    this.broadcast({ t: "finished", p: { result, winners, scores } }, "ALL");
    this.broadcastState();
  }

  private async persist(): Promise<void> {
    if (!this.meta || !this.game) return;
    await this.ctx.storage.put("meta", this.meta);
    await this.ctx.storage.put("saved", this.game.toSaved(this.meta.id));
  }
}

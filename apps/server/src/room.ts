/**
 * GameRoom: one Durable Object per game.
 *
 * Owns the seats, the engine game (persisted as MILA saved game JSON), orders, press, pledges and
 * votes in SQLite, every WebSocket (hibernating), and one alarm that serves every timer the room
 * has. Adjudicate, persist and broadcast happen in one place with no network hop.
 *
 * The rules this file enforces, in one place:
 *
 *  - Every change to a phase is one storage transaction. A throw rolls storage and memory back
 *    together, so a retried alarm or an evicted object can never adjudicate a phase twice.
 *  - A phase advances early only when every seat that can act is ready, AI seats included, and at
 *    least one present human is among the players. A game nobody human is playing is driven by
 *    its deadline alone and ends: it is finished when no human power survives, and abandoned after
 *    three movement phases without a human order.
 *  - Only live games pause when every human leaves, the pause keeps the time that was left, and it
 *    ends by itself. Daily and async games never look at who is connected.
 *  - A seat belongs to its player until that player has been gone for four movement phases. Two
 *    misses put it in civil disorder, where the bot covers it and the player takes it back by
 *    ordering. Only after four may a seated player invite a substitute.
 *  - Spectators are read-only: nothing a socket without a seat does can change the game.
 */
import { DurableObject } from "cloudflare:workers";
import {
  type GameRecord,
  type GameResult,
  type GameSettings as Settings,
  GameSettings,
  type OrderResultView,
  type PledgeView,
  type PowerName,
  type PressView,
  type SeatView,
  type ServerMessage,
  type StateView,
  type VotesView,
  parseClientMessage,
  ratingCluster,
  sumOfSquares,
} from "@cabal/protocol";
import { adjudicateStrict } from "./adjudicate-guard.js";
import { botOrders, canAct } from "./bot.js";
import {
  AI_TURN_LIMIT_MS,
  PAUSE_LIMIT_MS,
  LOBBY_TTL_MS,
  adjudicationRetryDelay,
  nextAlarmAt,
  outboxDelay,
  phaseSeconds,
  remainingMs,
} from "./deadlines.js";
import type { AgentTurn, Env } from "./env.js";
import {
  Game,
  POWERS,
  canonicalOrder,
  engineReady,
  pledgeCommit,
  pledgeReceipt,
  randomNonce,
} from "./engine.js";
import { REGISTRY_NAME } from "./registry.js";
import { hashToken, mintToken, parseToken, randomId } from "./tokens.js";

type Status = "lobby" | "active" | "paused" | "finished" | "abandoned";

/** Abuse limits. A room is single threaded, so every unbounded input is a way to stall a game. */
export const LIMITS = {
  /** Token bucket per socket: burst size and refill per second. */
  burst: 30,
  refillPerSecond: 10,
  /** A `sync` reads up to a page of events, so it costs more than an ordinary frame. */
  syncCost: 5,
  /** Largest client frame, in bytes. */
  frameBytes: 4096,
  /** Press messages one power may send in one phase. */
  pressPerPhase: 60,
  /** Events replayed by one `sync` request; clients page with `since`. */
  syncPage: 500,
  /** Press messages included in a welcome frame (the most recent ones). */
  welcomePress: 500,
  /** Sockets that have not bound to a seat. */
  spectators: 200,
  /** Sockets one seat may hold open (several tabs and devices). */
  socketsPerSeat: 8,
  /** Stored broadcast frames kept for `sync`. */
  eventsKept: 4000,
  /** Consecutive missed movement phases before a seat is in civil disorder. */
  civilDisorderAfter: 2,
  /** Consecutive missed movement phases before a seat is vacant and may be given to a substitute. */
  vacantAfter: 4,
  /** Consecutive movement phases with no human order before the game is abandoned. */
  abandonAfter: 3,
  /** Phases one trigger may resolve in a row (bot-only retreats and builds chain through). */
  chain: 4,
  /** Claude turns per game unless `CLAUDE_TURNS_PER_GAME` says otherwise. */
  claudeTurnsPerGame: 400,
  /** Press an AI seat may send in one turn, and the longest body. */
  agentMessages: 3,
  agentBodyChars: 1000,
} as const;

interface Finished {
  result: GameResult;
  winners: PowerName[];
  scores: Record<string, number>;
  reason: string | null;
}

interface Meta {
  id: string;
  settings: Settings;
  status: Status;
  createdAt: number;
  deadlineAt: number | null;
  creator: PowerName;
  finished: Finished | null;
  pauseReason: string | null;
  /** While paused: the phase time that was left, when the pause began and when it ends by itself. */
  pause: { remainingMs: number; since: number; until: number } | null;
  /** Pause time already spent in the current phase, so pausing cannot stall a phase for ever. */
  pausedMsThisPhase: number;
  /** The phase whose one-off grace period has been used. */
  gracePhase: string | null;
  /** Consecutive movement phases in which no human submitted an order. */
  idlePhases: number;
  /** Set while a failed adjudication waits for its next attempt. */
  retry: { attempts: number; at: number } | null;
  /** Set while Claude seats are still thinking about the current phase. */
  aiDueAt: number | null;
  /** Claude turns requested so far, against the per-game cap. */
  claudeTurns: number;
}

interface Outbox {
  record: GameRecord;
  attempts: number;
  nextAt: number;
  gaveUp?: boolean;
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
  /** Null until a `hello` frame binds the socket to a seat. */
  power: PowerName | null;
}

/** What a Claude seat needs to decide a turn. Served over the Durable Object binding only. */
export interface AgentBrief {
  gameId: string;
  power: PowerName;
  phase: string;
  state: StateView;
  press: PressView[];
  trust: Record<string, { kept: number; broken: number }>;
}

export interface AgentDecision {
  orders: string[];
  messages: { to: string; body: string }[];
  pledge: { to: string; orders: string[]; sealed: boolean } | null;
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
  source TEXT NOT NULL DEFAULT 'human',
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
  include_json TEXT,
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
CREATE TABLE IF NOT EXISTS substitute_invites (
  power TEXT PRIMARY KEY,
  invite_hash TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
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

function bearer(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

export class GameRoom extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private kv = this.ctx.storage.kv;
  private meta: Meta | null = null;
  private game: Game | null = null;
  /** Next Registry hand-off attempt; mirrors the stored outbox. */
  private outboxAt: number | null = null;
  private flushingOutbox = false;
  /** What the alarm is currently set to, so an unchanged schedule costs no storage write. */
  private armedAt: number | null = null;
  /** Frames recorded during the current change, sent to sockets once it has committed. */
  private pending: { payload: string; audience: PowerName | "ALL"; only?: WebSocket }[] = [];
  /** Claude turns to put on the queue once the current change has committed. */
  private turns: AgentTurn[] = [];
  /** Per-socket rate limit buckets. In memory only: hibernation resets them, which is harmless. */
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered by the runtime without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      await engineReady();
      const stored = this.kv.get<Partial<Meta> & Pick<Meta, "id" | "status" | "createdAt" | "creator">>("meta");
      // Looking up a code that names no game must not write storage; create() lays the schema down.
      if (!stored) return;
      this.migrate();
      const now = Date.now();
      // A stored game outlives schema changes: settings that no longer validate are kept as they are.
      const parsed = GameSettings.safeParse(stored.settings);
      const meta: Meta = {
        id: stored.id,
        settings: parsed.success ? parsed.data : (stored.settings as Settings),
        status: stored.status,
        createdAt: stored.createdAt,
        deadlineAt: stored.deadlineAt ?? null,
        creator: stored.creator,
        finished: stored.finished ? { ...stored.finished, reason: stored.finished.reason ?? null } : null,
        pauseReason: stored.pauseReason ?? null,
        pause: stored.pause ?? null,
        pausedMsThisPhase: stored.pausedMsThisPhase ?? 0,
        gracePhase: stored.gracePhase ?? null,
        idlePhases: stored.idlePhases ?? 0,
        retry: stored.retry ?? null,
        aiDueAt: stored.aiDueAt ?? null,
        claudeTurns: stored.claudeTurns ?? 0,
      };
      this.meta = meta;
      const saved = this.kv.get<string>("saved");
      this.game = saved ? Game.fromSaved(saved, meta.settings.rulebook) : new Game(meta.settings.rulebook);
      // Rooms written before pauses kept their clock: resume them with a full phase.
      if (meta.status === "paused" && !meta.pause) {
        meta.status = "active";
        meta.pauseReason = null;
      }
      if (meta.status === "active" && meta.deadlineAt === null && !meta.retry) {
        meta.deadlineAt = now + phaseSeconds(this.game.phase(), meta.settings) * 1000;
      }
      if (JSON.stringify(meta) !== JSON.stringify(stored)) this.kv.put("meta", meta);
      const outbox = this.kv.get<Outbox>("registry-outbox");
      this.outboxAt = outbox && !outbox.gaveUp && env.REGISTRY ? outbox.nextAt : null;
      // A lost or stale alarm is repaired on every wake.
      const want = this.alarmAt();
      const have = await ctx.storage.getAlarm();
      if (want === null && have !== null) await ctx.storage.deleteAlarm();
      else if (want !== null && have !== want) await ctx.storage.setAlarm(want);
      this.armedAt = want;
    });
  }

  /** Create the tables, then bring rooms from older deployments up to the current shape. */
  private migrate(): void {
    this.sql.exec(SCHEMA);
    const has = (table: string, column: string) =>
      this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().some((c) => c.name === column);
    if (!has("orders", "source")) this.sql.exec("ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'human'");
    if (!has("votes", "include_json")) this.sql.exec("ALTER TABLE votes ADD COLUMN include_json TEXT");
    // AI seats no longer hold bearer tokens: the Durable Object binding is the credential.
    this.sql.exec("DROP TABLE IF EXISTS agent_tokens");
    this.sql.exec("UPDATE seats SET token_hash = NULL WHERE kind = 'ai'");
  }

  private log(event: string, fields: Record<string, unknown> = {}, level: "info" | "error" = "info"): void {
    const line = JSON.stringify({ event, gameId: this.meta?.id ?? null, phase: this.game?.phase() ?? null, ...fields });
    if (level === "error") console.error(line);
    else console.info(line);
  }

  // ---------- transactions and the alarm ----------

  /**
   * Run one change to the room as a single storage transaction. A throw rolls back the SQL and
   * key-value writes, the in-memory meta and the frames queued by the change, so storage, memory
   * and what clients were told can never disagree.
   */
  private atomic<T>(change: () => T): T {
    const metaBefore = this.meta ? structuredClone(this.meta) : null;
    const framesBefore = this.pending.length;
    const turnsBefore = this.turns.length;
    const outboxBefore = this.outboxAt;
    try {
      return this.ctx.storage.transactionSync(() => {
        const result = change();
        if (this.meta) this.kv.put("meta", this.meta);
        return result;
      });
    } catch (error) {
      this.meta = metaBefore;
      this.pending.length = framesBefore;
      this.turns.length = turnsBefore;
      this.outboxAt = outboxBefore;
      throw error;
    }
  }

  private alarmAt(): number | null {
    if (!this.meta) return null;
    return nextAlarmAt({
      status: this.meta.status,
      createdAt: this.meta.createdAt,
      deadlineAt: this.meta.deadlineAt,
      retryAt: this.meta.retry?.at ?? null,
      aiDueAt: this.meta.aiDueAt,
      pausedUntil: this.meta.pause?.until ?? null,
      outboxAt: this.outboxAt,
    });
  }

  /** Point the room's single alarm at whatever is due next. */
  private rearm(): void {
    const at = this.alarmAt();
    if (at === this.armedAt) return;
    this.armedAt = at;
    // Not awaited: the write joins the same atomic batch as the change that caused it.
    if (at === null) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(at);
  }

  /** After a change has committed: re-arm, deliver its frames, queue its Claude turns. */
  private settle(): void {
    this.rearm();
    const frames = this.pending.splice(0);
    if (frames.length > 0) {
      const sockets = this.ctx.getWebSockets().map((ws) => ({ ws, power: (ws.deserializeAttachment() as Attachment | null)?.power ?? null }));
      for (const frame of frames) {
        for (const { ws, power } of sockets) {
          if (frame.only ? frame.only !== ws : frame.audience !== "ALL" && frame.audience !== power) continue;
          try {
            ws.send(frame.payload);
          } catch {
            // socket already gone; hibernation will clean it up
          }
        }
      }
    }
    const turns = this.turns.splice(0);
    if (turns.length > 0) this.ctx.waitUntil(this.dispatchTurns(turns));
  }

  override async alarm(): Promise<void> {
    // The alarm that woke us is spent, whatever it was set to.
    this.armedAt = null;
    if (!this.meta || !this.game) return;
    const now = Date.now();
    try {
      if (this.outboxAt !== null && now >= this.outboxAt) await this.flushOutbox();
      const meta = this.meta;
      if (meta.status === "lobby" && now >= meta.createdAt + LOBBY_TTL_MS) {
        this.atomic(() => this.conclude("abandoned", [], "lobby_expired", false));
      } else if (meta.status === "paused" && meta.pause && now >= meta.pause.until) {
        this.atomic(() => this.resume("timeout"));
        this.advance();
      }
      if (this.meta.status === "active" && this.meta.aiDueAt !== null && now >= this.meta.aiDueAt) {
        this.releaseAiSeats("timeout");
      }
      if (this.meta.status === "active") {
        if (this.meta.retry) {
          if (now >= this.meta.retry.at) this.adjudicate();
        } else if (this.meta.deadlineAt !== null && now >= this.meta.deadlineAt) {
          this.onDeadline();
        }
      }
    } catch (error) {
      // Never let the runtime retry an alarm blind: log, re-arm from durable state, carry on.
      this.log("alarm_failed", { error: String(error) }, "error");
    } finally {
      this.settle();
    }
  }

  // ---------- HTTP entry (called by the router) ----------

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/create") return await this.create(request);
      if (request.method === "POST" && path === "/join") return await this.join(request);
      if (request.method === "POST" && path === "/start") return this.start(request);
      if (request.method === "POST" && path === "/substitute") return await this.inviteSubstitute(request);
      if (request.method === "GET" && path === "/summary") {
        if (!this.meta) return bad("no such game", 404);
        return json(this.summary());
      }
      if (request.method === "GET" && path === "/ledger") {
        if (!this.meta) return bad("no such game", 404);
        return json({ gameId: this.meta.id, ledger: this.ledger() });
      }
      if (request.method === "GET" && path === "/replay") {
        if (!this.game || !this.meta) return bad("no such game", 404);
        return new Response(this.game.toSaved(this.meta.id), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (path === "/ws") return this.openSocket(request);
      return bad("not found", 404);
    } finally {
      if (this.meta) this.settle();
    }
  }

  private async create(request: Request): Promise<Response> {
    if (this.meta) return bad("game exists", 409);
    // The router has already validated and resolved the settings.
    const body = (await request.json()) as { id: string; name: string; settings: Settings };
    const settings = GameSettings.parse(body.settings);
    const creator = POWERS[Math.floor(Math.random() * POWERS.length)] as PowerName;
    const token = mintToken(body.id, creator);
    this.atomic(() => {
      this.migrate();
      this.meta = {
        id: body.id,
        settings,
        status: "lobby",
        createdAt: Date.now(),
        deadlineAt: null,
        creator,
        finished: null,
        pauseReason: null,
        pause: null,
        pausedMsThisPhase: 0,
        gracePhase: null,
        idlePhases: 0,
        retry: null,
        aiDueAt: null,
        claudeTurns: 0,
      };
      this.game = new Game(settings.rulebook);
      for (const p of POWERS) this.sql.exec("INSERT INTO seats (power, kind) VALUES (?, 'open')", p);
      this.sql.exec("UPDATE seats SET kind = 'human', name = ?, token_hash = ? WHERE power = ?", body.name, hashToken(token), creator);
      this.kv.put("saved", this.game.toSaved(body.id));
    });
    this.log("game_created", { pacing: settings.pacing, press: settings.press, aiBrain: settings.aiBrain });
    return json({ gameId: body.id, token, power: creator });
  }

  private async join(request: Request): Promise<Response> {
    if (!this.meta) return bad("no such game", 404);
    const meta = this.meta;
    const body = (await request.json()) as { name: string; power?: PowerName; invite?: string };
    // One player, one seat: a caller who already holds a seat here cannot take another.
    if (this.authorise(bearer(request))) return bad("you already hold a seat in this game", 409);
    // Everything from here to the write is synchronous, so two joins can never pick the same seat.
    if (meta.status === "lobby") {
      const open = this.seats().filter((s) => s.kind === "open");
      const chosen = (body.power && open.find((s) => s.power === body.power)) ?? open[Math.floor(Math.random() * open.length)];
      if (!chosen) return bad("no open seats", 409);
      const token = mintToken(meta.id, chosen.power);
      this.atomic(() => {
        this.sql.exec(
          "UPDATE seats SET kind = 'human', name = ?, token_hash = ?, missed = 0, ready = 0 WHERE power = ?",
          body.name,
          hashToken(token),
          chosen.power,
        );
        this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
        if (this.seats().every((s) => s.kind !== "open")) this.begin();
      });
      this.log("seat_joined", { power: chosen.power });
      return json({ gameId: meta.id, token, power: chosen.power });
    }
    if (meta.status !== "active" && meta.status !== "paused") return bad("game is over", 409);
    if (!body.invite) return bad("game already started", 409);
    // A running game only admits an invited substitute, and only into a seat its player has left.
    const invite = this.sql
      .exec<{ power: PowerName }>("SELECT power FROM substitute_invites WHERE invite_hash = ?", hashToken(body.invite))
      .toArray()[0];
    if (!invite) return bad("invite is not valid", 403);
    const seat = this.seat(invite.power);
    if (!seat || !this.vacant(seat)) {
      this.sql.exec("DELETE FROM substitute_invites WHERE power = ?", invite.power);
      return bad("that seat is no longer vacant", 409);
    }
    const token = mintToken(meta.id, seat.power);
    this.atomic(() => {
      this.sql.exec(
        "UPDATE seats SET kind = 'human', name = ?, token_hash = ?, missed = 0, ready = 0 WHERE power = ?",
        body.name,
        hashToken(token),
        seat.power,
      );
      this.sql.exec("DELETE FROM substitute_invites WHERE power = ?", seat.power);
      this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    });
    // The previous owner's token is dead, so their open sockets must go with it.
    this.closeSeatSockets(seat.power, 4001, "seat reassigned");
    this.log("seat_substituted", { power: seat.power });
    return json({ gameId: meta.id, token, power: seat.power });
  }

  /** A seated, present player opens one vacated seat to whoever they hand the invite to. */
  private async inviteSubstitute(request: Request): Promise<Response> {
    if (!this.meta) return bad("no such game", 404);
    if (this.meta.status !== "active" && this.meta.status !== "paused") return bad("the game is not running", 409);
    const issuer = this.authorise(bearer(request));
    const issuerSeat = issuer ? this.seat(issuer) : undefined;
    if (!issuerSeat || issuerSeat.kind !== "human" || issuerSeat.eliminated === 1) {
      return bad("only a seated player may invite a substitute", 403);
    }
    const body = (await request.json()) as { power: PowerName };
    const seat = this.seat(body.power);
    if (!seat || seat.power === issuer) return bad("no such seat", 404);
    if (!this.vacant(seat)) {
      return bad(`a seat opens to a substitute after its player has missed ${LIMITS.vacantAfter} movement phases`, 409);
    }
    const invite = randomId(16);
    this.sql.exec(
      "INSERT INTO substitute_invites (power, invite_hash, issued_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(power) DO UPDATE SET invite_hash = excluded.invite_hash, issued_by = excluded.issued_by, created_at = excluded.created_at",
      seat.power,
      hashToken(invite),
      issuerSeat.power,
      Date.now(),
    );
    this.log("substitute_invited", { power: seat.power, by: issuerSeat.power });
    return json({ gameId: this.meta.id, power: seat.power, invite });
  }

  /** The creator starts early; open seats become AI seats when `aiFill` is on. */
  private start(request: Request): Response {
    if (!this.meta) return bad("no such game", 404);
    const auth = this.authorise(bearer(request));
    if (!auth || auth !== this.meta.creator) return bad("only the creator may start the game", 403);
    if (this.meta.status !== "lobby") return bad("game already started", 409);
    if (!this.meta.settings.aiFill && this.seats().some((s) => s.kind === "open")) {
      return bad("seats are still open", 409);
    }
    this.atomic(() => {
      this.sql.exec("UPDATE seats SET kind = 'ai', name = 'Automaton', token_hash = NULL WHERE kind = 'open'");
      this.begin();
    });
    return json(this.summary());
  }

  /** Lobby to active. Runs inside the caller's transaction. */
  private begin(): void {
    const meta = this.meta!;
    meta.status = "active";
    this.broadcast({ t: "status", p: { status: "active", reason: null } }, "ALL");
    this.startPhase();
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    this.broadcastState();
    this.log("game_started", { humans: this.activeHumans().length });
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
      pausedUntil: this.meta?.pause?.until ?? null,
      pausedRemainingMs: this.meta?.pause?.remainingMs ?? null,
    };
  }

  private ledger(): Record<string, { kept: number; broken: number; void: number }> {
    const ledger: Record<string, { kept: number; broken: number; void: number }> = Object.fromEntries(
      POWERS.map((power) => [power, { kept: 0, broken: 0, void: 0 }]),
    );
    for (const row of this.sql
      .exec<{ pledger: string; receipt: "kept" | "broken" | "void"; n: number }>(
        "SELECT pledger, receipt, COUNT(*) AS n FROM pledges WHERE receipt IS NOT NULL GROUP BY pledger, receipt",
      )
      .toArray()) {
      const entry = ledger[row.pledger];
      if (entry && row.receipt in entry) entry[row.receipt] = row.n;
    }
    return ledger;
  }

  // ---------- seats and auth ----------

  private seats(): SeatRow[] {
    return this.sql.exec<SeatRow>("SELECT * FROM seats ORDER BY power").toArray();
  }

  private seat(power: PowerName): SeatRow | undefined {
    return this.sql.exec<SeatRow>("SELECT * FROM seats WHERE power = ?", power).toArray()[0];
  }

  /** The bot covers a civil-disorder seat when the game fills seats with AI. */
  private autopilot(seat: SeatRow): boolean {
    return seat.kind === "civil_disorder" && seat.eliminated === 0 && !!this.meta?.settings.aiFill;
  }

  /** Gone long enough that the seat may be handed to an invited substitute. */
  private vacant(seat: SeatRow): boolean {
    return seat.kind === "civil_disorder" && seat.eliminated === 0 && seat.missed >= LIMITS.vacantAfter;
  }

  /** Seats a person is playing right now: human, not in civil disorder, not eliminated. */
  private activeHumans(): SeatRow[] {
    return this.seats().filter((s) => s.kind === "human" && s.eliminated === 0);
  }

  private seatViews(): SeatView[] {
    return this.seats().map((s) => ({
      power: s.power,
      kind: s.kind,
      name: s.name,
      ready: s.ready === 1,
      eliminated: s.eliminated === 1,
      missed: s.missed,
      autopilot: this.autopilot(s),
    }));
  }

  private authorise(token: string): PowerName | null {
    const parsed = parseToken(token);
    if (!parsed || !this.meta || parsed.gameId !== this.meta.id) return null;
    const seat = this.seat(parsed.power as PowerName);
    if (!seat?.token_hash) return null;
    return hashToken(token) === seat.token_hash ? seat.power : null;
  }

  // ---------- WebSockets ----------

  private socketsOf(power: PowerName | null, except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      if (ws === except || ws.readyState !== WebSocket.OPEN) return false;
      return ((ws.deserializeAttachment() as Attachment | null)?.power ?? null) === power;
    });
  }

  private closeSeatSockets(power: PowerName, code: number, reason: string): void {
    for (const ws of this.socketsOf(power)) {
      ws.serializeAttachment({ power: null } satisfies Attachment);
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    }
  }

  /**
   * Every socket starts as a spectator. A seat token never travels in the URL (URLs are logged):
   * the client sends it in a `hello` frame, which binds the socket to its seat.
   */
  private openSocket(request: Request): Response {
    if (request.headers.get("upgrade") !== "websocket") return bad("expected websocket", 426);
    if (!this.meta || !this.game) return bad("no such game", 404);
    if (new URL(request.url).searchParams.has("token")) {
      return bad("send the seat token in a hello frame, not in the URL", 400);
    }
    if (this.socketsOf(null).length >= LIMITS.spectators) return bad("too many spectators", 503);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ power: null } satisfies Attachment);
    this.send(server, { t: "welcome", p: this.welcome(null) });
    return new Response(null, { status: 101, webSocket: client });
  }

  private hello(ws: WebSocket, id: string | undefined, token: string): void {
    const power = this.authorise(token);
    if (!power) {
      this.send(ws, { t: "error", id, p: { code: "bad_token", message: "that seat token is not valid" } });
      ws.close(4401, "bad token");
      return;
    }
    if (this.socketsOf(power, ws).length >= LIMITS.socketsPerSeat) {
      this.send(ws, { t: "error", id, p: { code: "too_many_sockets", message: "this seat has too many open connections" } });
      ws.close(4429, "too many sockets");
      return;
    }
    ws.serializeAttachment({ power } satisfies Attachment);
    this.presenceChanged();
    this.send(ws, { t: "welcome", id, p: this.welcome(power) });
  }

  private welcome(power: PowerName | null): Extract<ServerMessage, { t: "welcome" }>["p"] {
    const meta = this.meta!;
    const game = this.game!;
    const phase = game.phase();
    const orders = power ? (this.storedOrders(phase, power)?.orders ?? []) : [];
    return {
      gameId: meta.id,
      settings: meta.settings,
      status: meta.status,
      pauseReason: meta.pauseReason,
      pausedUntil: meta.pause?.until ?? null,
      pausedRemainingMs: meta.pause?.remainingMs ?? null,
      power,
      phase,
      state: game.state() as StateView,
      seats: this.seatViews(),
      deadlineAt: meta.deadlineAt,
      seq: this.lastSeq(),
      orders,
      press: this.pressFor(power),
      votes: this.votesView(),
    };
  }

  /** Spend tokens from the socket's bucket; false when it cannot afford the frame. */
  private allow(ws: WebSocket, cost = 1): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ws) ?? { tokens: LIMITS.burst, at: now };
    bucket.tokens = Math.min(LIMITS.burst, bucket.tokens + ((now - bucket.at) / 1000) * LIMITS.refillPerSecond);
    bucket.at = now;
    const ok = bucket.tokens >= cost;
    if (ok) bucket.tokens -= cost;
    this.buckets.set(ws, bucket);
    return ok;
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      await this.onFrame(ws, raw);
    } finally {
      if (this.meta) this.settle();
    }
  }

  private async onFrame(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // The limiter comes first, so no frame of any size or kind is ever free.
    if (!this.allow(ws)) {
      return this.send(ws, { t: "error", p: { code: "rate_limited", message: "slow down" } });
    }
    // A string's UTF-8 size is at least its length, so the cheap test catches every large frame.
    if (typeof raw !== "string" || raw.length > LIMITS.frameBytes || new TextEncoder().encode(raw).byteLength > LIMITS.frameBytes) {
      this.send(ws, { t: "error", p: { code: "too_large", message: "frames are JSON text of at most 4 KB" } });
      ws.close(1009, "frame too large");
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return this.send(ws, { t: "error", p: { code: "bad_json", message: "frame is not JSON" } });
    }
    const msg = parseClientMessage(data);
    if (!msg) return this.send(ws, { t: "error", p: { code: "bad_frame", message: "frame did not validate" } });
    const id = "id" in msg ? msg.id : undefined;
    if (!this.meta || !this.game) return;
    if (msg.t === "hello") return this.hello(ws, id, msg.p.token);
    const { power } = (ws.deserializeAttachment() as Attachment | null) ?? { power: null };
    if (msg.t === "sync") {
      if (!this.allow(ws, LIMITS.syncCost - 1)) {
        return this.send(ws, { t: "error", id, p: { code: "rate_limited", message: "slow down" } });
      }
      const events = this.eventsSince(msg.p.since, power);
      for (const ev of events) ws.send(ev.payload_json);
      const seq = events.at(-1)?.seq ?? msg.p.since;
      return this.send(ws, { t: "synced", id, p: { seq, more: events.length === LIMITS.syncPage } });
    }
    // Everything below changes the game, and only a seat may do that.
    if (!power) return this.send(ws, { t: "error", id, p: { code: "spectator", message: "spectators cannot act" } });
    const status = this.meta.status;
    // A returning player may hand in orders while a live game is paused: that is what un-pauses it.
    const allowed = status === "active" || (status === "paused" && msg.t === "orders.set");
    if (!allowed) {
      return this.send(ws, { t: "error", id, p: { code: "not_active", message: "the game is not active" } });
    }
    switch (msg.t) {
      case "orders.set": {
        const outcome = this.setOrders(power, msg.p.phase, msg.p.orders, "human");
        if ("code" in outcome) return this.send(ws, { t: "error", id, p: outcome });
        return this.send(ws, { t: "orders.ack", id, p: { phase: msg.p.phase, ...outcome } });
      }
      case "orders.default":
        return this.setDefaults(ws, id, power, msg.p.orders);
      case "ready":
        return this.setReady(ws, id, power, msg.p.phase, msg.p.ready);
      case "extend":
        return this.requestExtension(ws, id, power, msg.p.phase);
      case "press.send": {
        if (this.env.PRESS_LIMITER) {
          // Keyed by seat, never by address: a whole campus can sit behind one IP.
          const { success } = await this.env.PRESS_LIMITER.limit({ key: `${this.meta.id}:${power}` });
          if (!success) {
            return this.send(ws, { t: "error", id, p: { code: "press_rate_limited", message: "too many press messages, try again later" } });
          }
        }
        // The await above may have let the phase move on: every check below reads fresh state.
        if (this.meta.status !== "active") {
          return this.send(ws, { t: "error", id, p: { code: "not_active", message: "the game is not active" } });
        }
        const error = this.press(power, msg.p.to, msg.p.body, msg.p.pledge, { ws, id });
        if (error) this.send(ws, { t: "error", id, p: error });
        return;
      }
      case "vote":
        return this.vote(ws, id, power, msg.p.value, msg.p.include);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      // 1005 and 1006 are reserved: they describe a close and may not be sent in one.
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    this.socketGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.socketGone(ws);
  }

  private socketGone(ws: WebSocket): void {
    if (!this.meta) return;
    // A spectator leaving is never an event in the game.
    const { power } = (ws.deserializeAttachment() as Attachment | null) ?? { power: null };
    if (power) this.presenceChanged(ws);
    this.settle();
  }

  // ---------- presence and pausing (live pacing only) ----------

  /**
   * Called when a seat's socket binds or goes away. Live games pause while no human player is
   * connected; daily and async games ignore connections entirely, because nobody keeps a tab open
   * for two days and absence there is what deadlines and civil disorder are for.
   */
  private presenceChanged(gone?: WebSocket): void {
    const meta = this.meta;
    if (!meta || meta.settings.pacing !== "live") return;
    if (meta.status !== "active" && meta.status !== "paused") return;
    const humans = this.activeHumans();
    const present = humans.some((seat) => this.socketsOf(seat.power, gone).length > 0);
    if (meta.status === "active" && !present && humans.length > 0 && !meta.retry) {
      const budget = PAUSE_LIMIT_MS - meta.pausedMsThisPhase;
      if (budget <= 0) return; // this phase has used its pause allowance: the clock keeps running
      this.atomic(() => {
        const now = Date.now();
        meta.pause = { remainingMs: remainingMs(meta.deadlineAt, now), since: now, until: now + budget };
        meta.status = "paused";
        meta.pauseReason = "humans_absent";
        meta.deadlineAt = null;
        this.broadcast({ t: "status", p: { status: "paused", reason: "humans_absent", until: meta.pause.until } }, "ALL");
        this.broadcast({ t: "deadline", p: { phase: this.game!.phase(), deadlineAt: null } }, "ALL");
      });
      this.log("game_paused", { remainingMs: meta.pause?.remainingMs, until: meta.pause?.until });
    } else if (meta.status === "paused" && present) {
      this.atomic(() => this.resume("returned"));
      this.advance();
    }
  }

  /** Paused to active with exactly the time that was left. Runs inside the caller's transaction. */
  private resume(why: "returned" | "timeout"): void {
    const meta = this.meta!;
    if (meta.status !== "paused" || !meta.pause) return;
    const now = Date.now();
    meta.pausedMsThisPhase += Math.max(0, now - meta.pause.since);
    meta.deadlineAt = now + meta.pause.remainingMs;
    meta.pause = null;
    meta.status = "active";
    meta.pauseReason = null;
    this.broadcast({ t: "status", p: { status: "active", reason: null } }, "ALL");
    this.broadcast({ t: "deadline", p: { phase: this.game!.phase(), deadlineAt: meta.deadlineAt } }, "ALL");
    this.log("game_resumed", { why, deadlineAt: meta.deadlineAt });
  }

  // ---------- frames ----------

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // socket already gone; hibernation will clean it up
    }
  }

  /**
   * Record a frame for `sync` and queue it for delivery. Delivery happens in `settle`, after the
   * change that produced the frame has committed, so a rolled back change is never announced.
   */
  private broadcast(message: ServerMessage, audience: PowerName | "ALL"): void {
    const payload = JSON.stringify(message);
    this.sql.exec("INSERT INTO events (audience, payload_json) VALUES (?, ?)", audience, payload);
    this.pending.push({ payload, audience });
  }

  private lastSeq(): number {
    return this.sql.exec<{ n: number | null }>("SELECT MAX(seq) AS n FROM events").one().n ?? 0;
  }

  private eventsSince(since: number, power: PowerName | null): { seq: number; payload_json: string }[] {
    return this.sql
      .exec<{ seq: number; payload_json: string }>(
        "SELECT seq, payload_json FROM events WHERE seq > ? AND (audience = 'ALL' OR audience = ?) ORDER BY seq LIMIT ?",
        since,
        power ?? "ALL",
        LIMITS.syncPage,
      )
      .toArray();
  }

  private broadcastState(): void {
    if (!this.game || !this.meta) return;
    this.broadcast(
      {
        t: "state",
        p: {
          phase: this.game.phase(),
          state: this.game.state() as StateView,
          deadlineAt: this.meta.deadlineAt,
          seq: this.lastSeq(),
          status: this.meta.status,
        },
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
    return canonicalOrder(text, kind, power);
  }

  private storedOrders(phase: string, power: PowerName): { orders: string[]; source: string } | undefined {
    const row = this.sql
      .exec<{ orders_json: string; source: string }>("SELECT orders_json, source FROM orders WHERE phase = ? AND power = ?", phase, power)
      .toArray()[0];
    return row ? { orders: this.parseOrderList(row.orders_json), source: row.source } : undefined;
  }

  private writeOrders(phase: string, power: PowerName, orders: string[], source: "human" | "bot" | "claude"): void {
    this.sql.exec(
      "INSERT INTO orders (phase, power, orders_json, submitted_at, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(phase, power) DO UPDATE SET orders_json = excluded.orders_json, submitted_at = excluded.submitted_at, source = excluded.source",
      phase,
      power,
      JSON.stringify(orders),
      Date.now(),
      source,
    );
  }

  /** Replace a seat's orders for the current phase. Returns what was accepted, or an error. */
  private setOrders(
    power: PowerName,
    phase: string,
    orders: string[],
    source: "human" | "claude",
  ): { accepted: string[]; rejected: { text: string; reason: string }[] } | { code: string; message: string } {
    const game = this.game!;
    const seat = this.seat(power);
    if (!seat || seat.eliminated === 1) return { code: "seat_inactive", message: "this seat cannot submit orders" };
    if (phase !== game.phase()) return { code: "stale_phase", message: `current phase is ${game.phase()}` };
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
    // A Claude turn with nothing usable leaves the bot's orders standing.
    if (source === "claude" && accepted.length === 0) return { accepted, rejected };
    let returned = false;
    this.atomic(() => {
      this.writeOrders(phase, power, accepted, source);
      // The player is back: orders are what takes a seat out of civil disorder.
      if (source === "human" && seat.kind === "civil_disorder" && accepted.length > 0) {
        this.sql.exec("UPDATE seats SET kind = 'human', missed = 0, ready = 0 WHERE power = ?", power);
        this.sql.exec("DELETE FROM substitute_invites WHERE power = ?", power);
        this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
        returned = true;
      }
    });
    if (returned) {
      this.log("seat_recovered", { power });
      this.presenceChanged();
    }
    return { accepted, rejected };
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

  private setReady(ws: WebSocket, id: string | undefined, power: PowerName, phase: string, ready: boolean): void {
    if (phase !== this.game!.phase()) {
      return this.send(ws, { t: "error", id, p: { code: "stale_phase", message: `current phase is ${this.game!.phase()}` } });
    }
    const seat = this.seat(power);
    if (!seat || seat.kind !== "human" || seat.eliminated === 1) {
      return this.send(ws, { t: "error", id, p: { code: "seat_inactive", message: "submit orders to take your seat back before readying" } });
    }
    if (seat.ready === (ready ? 1 : 0)) return; // unchanged: no write, no broadcast
    this.atomic(() => {
      this.sql.exec("UPDATE seats SET ready = ? WHERE power = ?", ready ? 1 : 0, power);
      this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    });
    if (ready) this.advance();
  }

  /** Seats that have something to order this phase and somebody (or something) to order it. */
  private acting(): SeatRow[] {
    const game = this.game!;
    return this.seats().filter(
      (s) => s.eliminated === 0 && (s.kind === "human" || s.kind === "ai" || this.autopilot(s)) && canAct(game, s.power),
    );
  }

  /**
   * Ready-advance. Every seat that can act must be ready, AI seats included, so a quick human can
   * never outrun an AI turn. The set must not be empty, and a game with no present human player
   * never advances early: it waits for its deadline, which is what ends it.
   */
  private readyToAdvance(): boolean {
    const meta = this.meta!;
    if (!meta.settings.readyAdvance || meta.status !== "active" || meta.retry) return false;
    if (this.activeHumans().length === 0) return false;
    const acting = this.acting();
    return acting.length > 0 && acting.every((s) => s.ready === 1);
  }

  /** Resolve the current phase if everybody is ready, and any bot-only phases that follow it. */
  private advance(): void {
    for (let i = 0; i < LIMITS.chain && this.readyToAdvance(); i++) this.adjudicate();
  }

  private requestExtension(ws: WebSocket, id: string | undefined, power: PowerName, phase: string): void {
    const meta = this.meta!;
    if (phase !== this.game!.phase()) {
      return this.send(ws, { t: "error", id, p: { code: "stale_phase", message: `current phase is ${this.game!.phase()}` } });
    }
    const humans = this.activeHumans();
    if (!humans.some((s) => s.power === power)) {
      return this.send(ws, { t: "error", id, p: { code: "seat_inactive", message: "only a present player may ask for more time" } });
    }
    const used = this.sql.exec<{ used: number }>("SELECT used FROM phase_extensions WHERE phase = ?", phase).toArray()[0]?.used ?? 0;
    if (used) return this.send(ws, { t: "error", id, p: { code: "extension_used", message: "this phase was already extended" } });
    // Two players must agree, unless only one is playing.
    const needed = Math.min(2, humans.length);
    let requestedBy: PowerName[] = [];
    let extended = false;
    this.atomic(() => {
      this.sql.exec("INSERT OR IGNORE INTO extension_requests (phase, power) VALUES (?, ?)", phase, power);
      requestedBy = this.sql
        .exec<{ power: PowerName }>("SELECT power FROM extension_requests WHERE phase = ? ORDER BY power", phase)
        .toArray()
        .map((r) => r.power)
        .filter((p) => humans.some((s) => s.power === p));
      extended = requestedBy.length >= needed;
      if (extended) {
        this.sql.exec("INSERT INTO phase_extensions (phase, used) VALUES (?, 1) ON CONFLICT(phase) DO UPDATE SET used = 1", phase);
        meta.deadlineAt = Math.max(Date.now(), meta.deadlineAt ?? Date.now()) + meta.settings.extendSeconds * 1000;
        this.broadcast({ t: "deadline", p: { phase, deadlineAt: meta.deadlineAt } }, "ALL");
      }
      this.broadcast({ t: "extend", p: { phase, requestedBy, needed, granted: extended, deadlineAt: meta.deadlineAt } }, "ALL");
    });
    if (extended) this.log("deadline_extended", { by: requestedBy, deadlineAt: meta.deadlineAt });
    this.send(ws, { t: "extend.ack", id, p: { phase, requests: requestedBy.length, extended } });
  }

  // ---------- press and pledges ----------

  private pressFor(power: PowerName | null, phase?: string): PressView[] {
    // The most recent messages this viewer may read, oldest first.
    const rows = this.sql
      .exec<{ id: string; phase: string; sender: string; recipient: string; body: string; sent_at: number; pledge_id: string | null }>(
        `SELECT * FROM (
           SELECT rowid AS rid, * FROM press WHERE (recipient = 'ALL' OR sender = ? OR recipient = ?) AND (? IS NULL OR phase = ?)
           ORDER BY sent_at DESC, rowid DESC LIMIT ?
         ) ORDER BY sent_at, rid`,
        power ?? "",
        power ?? "",
        phase ?? null,
        phase ?? null,
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

  /** Every order `power` could legally give this phase, in canonical text. */
  private legalMenu(power: PowerName, kind: "M" | "R" | "A"): Set<string> {
    const menu = new Set<string>();
    for (const order of Object.values(this.game!.legal(power).by_unit).flat()) {
      menu.add(order);
      try {
        menu.add(this.canonicalOwnOrder(order, kind, power));
      } catch {
        // the menu's own spelling is already in the set
      }
    }
    return menu;
  }

  /** Store and deliver one press message. Fully synchronous; returns an error to show the sender, or null. */
  private press(
    from: PowerName,
    to: PowerName | "ALL",
    body: string,
    pledge: { orders: string[]; sealed: boolean; nonce?: string | undefined } | undefined,
    origin?: { ws: WebSocket; id: string | undefined },
  ): { code: string; message: string } | null {
    const settings = this.meta!.settings;
    const kind = this.phaseKind();
    if (settings.rulebookPress && kind !== "M") {
      return { code: "press_closed", message: "rulebook press: no press during retreat and adjustment phases" };
    }
    if (settings.press === "gunboat") return { code: "no_press", message: "gunboat: no press" };
    if (settings.press === "public" && to !== "ALL") return { code: "public_only", message: "public press only" };
    const phase = this.game!.phase();
    const sent = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM press WHERE sender = ? AND phase = ?", from, phase).one().n;
    if (sent >= LIMITS.pressPerPhase) {
      return { code: "press_limit", message: `at most ${LIMITS.pressPerPhase} messages per phase` };
    }
    if (to !== "ALL" && settings.whisperBudget !== null) {
      const whispers = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM press WHERE sender = ? AND phase = ? AND recipient <> 'ALL'", from, phase)
        .one().n;
      if (whispers >= settings.whisperBudget) {
        return { code: "whisper_budget", message: `at most ${settings.whisperBudget} private messages per phase` };
      }
    }
    let canonical: string[] | null = null;
    if (pledge) {
      try {
        canonical = pledge.orders.map((o) => this.canonicalOwnOrder(o, kind, from));
      } catch (e) {
        return { code: "bad_pledge", message: e instanceof Error ? e.message : String(e) };
      }
      // A pledge is a promise about the pledger's own units. Syntax is not enough: an order for a
      // unit the pledger does not have would be stamped kept without ever being at risk.
      const menu = this.legalMenu(from, kind);
      const stranger = canonical.find((o) => !menu.has(o));
      if (stranger !== undefined) {
        return { code: "bad_pledge", message: `${stranger} is not an order one of your units can be given this phase` };
      }
    }
    this.atomic(() => {
      let pledgeId: string | null = null;
      if (pledge && canonical) {
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
        // A sealed pledge reads differently for its pledger, so each socket gets its own view.
        this.sql.exec("INSERT INTO events (audience, payload_json) VALUES ('ALL', ?)", JSON.stringify({ t: "press", p: view(null) }));
        for (const ws of this.ctx.getWebSockets()) {
          const viewer = (ws.deserializeAttachment() as Attachment | null)?.power ?? null;
          const message: ServerMessage = { t: "press", id: ws === origin?.ws ? origin.id : undefined, p: view(viewer) };
          this.pending.push({ payload: JSON.stringify(message), audience: "ALL", only: ws });
        }
      } else {
        this.broadcast({ t: "press", p: view(to) }, to);
        if (to !== from) this.broadcast({ t: "press", id: origin?.id, p: view(from) }, from);
      }
    });
    return null;
  }

  // ---------- draw votes ----------

  /** Surviving, present human players: the only seats whose agreement a draw needs. */
  private requiredVoters(): PowerName[] {
    return this.activeHumans().map((s) => s.power);
  }

  private votesView(): VotesView {
    const rows = this.sql
      .exec<{ power: PowerName; value: number; include_json: string | null }>("SELECT power, value, include_json FROM votes WHERE kind = 'draw' ORDER BY power")
      .toArray();
    return {
      phase: this.game!.phase(),
      draw: rows.map((r) => ({ power: r.power, value: r.value === 1, include: r.include_json ? (JSON.parse(r.include_json) as PowerName[]) : null })),
      required: this.requiredVoters(),
    };
  }

  /**
   * A draw passes when every surviving, present human player has voted yes this phase. Seats
   * played by AI, seats in civil disorder and eliminated players are never required, so a ghost
   * can never veto. DIAS shares the draw among all survivors; without DIAS the voters must also
   * name the same set of sharers, and only that changes: it still takes everyone to agree.
   */
  private vote(ws: WebSocket, id: string | undefined, power: PowerName, value: boolean, include: PowerName[] | undefined): void {
    const meta = this.meta!;
    const seat = this.seat(power);
    if (!seat || seat.kind !== "human" || (seat.eliminated === 1 && !meta.settings.ghostVotes)) {
      return this.send(ws, { t: "error", id, p: { code: "seat_inactive", message: "this seat cannot vote" } });
    }
    const survivors = new Set(this.seats().filter((s) => s.eliminated === 0).map((s) => s.power));
    let proposal: PowerName[] | null = null;
    if (!meta.settings.dias && include) {
      proposal = [...new Set(include)].sort();
      if (proposal.some((p) => !survivors.has(p))) {
        return this.send(ws, { t: "error", id, p: { code: "bad_vote", message: "a draw can only include surviving powers" } });
      }
      if (proposal.length === survivors.size) proposal = null; // everyone: the same as naming nobody
    }
    this.atomic(() => {
      this.sql.exec(
        "INSERT INTO votes (power, kind, value, include_json) VALUES (?, 'draw', ?, ?) ON CONFLICT(power, kind) DO UPDATE SET value = excluded.value, include_json = excluded.include_json",
        power,
        value ? 1 : 0,
        proposal ? JSON.stringify(proposal) : null,
      );
      const votes = this.votesView();
      this.broadcast({ t: "votes", p: votes }, "ALL");
      if (votes.required.length === 0) return;
      const ballots = votes.required.map((p) => votes.draw.find((v) => v.power === p));
      if (!ballots.every((b) => b?.value === true)) return;
      const proposals = new Set(ballots.map((b) => JSON.stringify(b!.include)));
      if (proposals.size !== 1) return; // everybody wants a draw, but not the same one
      const agreed = ballots[0]!.include;
      this.game!.declareDraw();
      this.conclude("draw", agreed ?? [...survivors], "vote");
    });
  }

  // ---------- phases, deadlines and adjudication ----------

  private claudeBudget(): number {
    const configured = Number(this.env.CLAUDE_TURNS_PER_GAME);
    return Number.isFinite(configured) && configured >= 0 ? configured : LIMITS.claudeTurnsPerGame;
  }

  /**
   * Open the current phase: set its clock and let every AI-played seat move. The bot's orders go
   * on file at once for every such seat, so no AI seat can ever leave a phase without orders.
   * Claude seats are then asked for better ones and stay un-ready until they answer or time out.
   * Runs inside the caller's transaction.
   */
  private startPhase(): void {
    const meta = this.meta!;
    const game = this.game!;
    const phase = game.phase();
    const now = Date.now();
    meta.deadlineAt = now + phaseSeconds(phase, meta.settings) * 1000;
    meta.retry = null;
    meta.aiDueAt = null;
    meta.pausedMsThisPhase = 0;
    this.sql.exec("UPDATE seats SET ready = 0");
    const humansPlaying = this.activeHumans().length > 0;
    const claude =
      meta.settings.aiBrain === "claude" && !!this.env.ANTHROPIC_API_KEY && !!this.env.AGENT_QUEUE && humansPlaying;
    const asked: PowerName[] = [];
    for (const seat of this.seats()) {
      if (seat.eliminated === 1 || !(seat.kind === "ai" || this.autopilot(seat)) || !canAct(game, seat.power)) continue;
      this.writeOrders(phase, seat.power, botOrders(game, seat.power, meta.id), "bot");
      if (claude && seat.kind === "ai" && meta.claudeTurns < this.claudeBudget()) {
        meta.claudeTurns += 1;
        asked.push(seat.power);
      } else {
        this.sql.exec("UPDATE seats SET ready = 1 WHERE power = ?", seat.power);
      }
    }
    if (asked.length > 0) {
      meta.aiDueAt = Math.min(now + AI_TURN_LIMIT_MS, meta.deadlineAt);
      for (const power of asked) this.turns.push({ gameId: meta.id, power, phase });
    }
    this.broadcast({ t: "deadline", p: { phase, deadlineAt: meta.deadlineAt } }, "ALL");
  }

  /** Put Claude turns on the queue. If the queue is down the bot's orders simply stand. */
  private async dispatchTurns(turns: AgentTurn[]): Promise<void> {
    try {
      await this.env.AGENT_QUEUE!.sendBatch(turns.map((body) => ({ body })));
    } catch (error) {
      this.log("agent_queue_failed", { error: String(error), turns: turns.length }, "error");
      if (this.game?.phase() === turns[0]?.phase) {
        this.releaseAiSeats("queue_failed");
        this.settle();
      }
    }
  }

  /** Stop waiting for Claude: every AI seat is ready with the orders it already has on file. */
  private releaseAiSeats(why: string): void {
    const meta = this.meta!;
    if (meta.status !== "active" && meta.status !== "paused") return;
    const waiting = this.seats().filter((s) => s.kind === "ai" && s.eliminated === 0 && s.ready === 0 && canAct(this.game!, s.power));
    this.atomic(() => {
      meta.aiDueAt = null;
      if (waiting.length === 0) return;
      this.sql.exec("UPDATE seats SET ready = 1 WHERE kind = 'ai' AND eliminated = 0");
      this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    });
    if (waiting.length > 0) this.log("agent_turns_released", { why, powers: waiting.map((s) => s.power) });
    this.advance();
  }

  /** The phase clock ran out: grant the one-off grace period if somebody still owes orders, else resolve. */
  private onDeadline(): void {
    const meta = this.meta!;
    const game = this.game!;
    const phase = game.phase();
    if (meta.settings.graceSeconds > 0 && meta.gracePhase !== phase) {
      const kind = this.phaseKind();
      const late = this.activeHumans().filter((seat) => {
        if (!canAct(game, seat.power)) return false;
        const stored = this.storedOrders(phase, seat.power);
        if (stored?.source === "human" && stored.orders.length > 0) return false;
        return !(kind === "M" && this.defaultOrders(seat.power).length > 0);
      });
      if (late.length > 0) {
        this.atomic(() => {
          meta.gracePhase = phase;
          meta.deadlineAt = Date.now() + meta.settings.graceSeconds * 1000;
          this.broadcast({ t: "deadline", p: { phase, deadlineAt: meta.deadlineAt, grace: true } }, "ALL");
        });
        this.log("grace_started", { late: late.map((s) => s.power), deadlineAt: meta.deadlineAt });
        return;
      }
    }
    this.adjudicate();
    this.advance();
  }

  private defaultOrders(power: PowerName): string[] {
    const row = this.sql.exec<{ orders_json: string }>("SELECT orders_json FROM defaults WHERE power = ?", power).toArray()[0];
    return row ? this.parseOrderList(row.orders_json) : [];
  }

  private parseOrderList(raw: string): string[] {
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  /** The one call into the engine for a phase. A seam: tests replace it to make adjudication fail. */
  private resolvePhase(game: Game, orders: Record<string, string[]>): ReturnType<Game["process"]> {
    return adjudicateStrict(game, { orders }, (e) => this.log("adjudicate_failed", { error: String(e) }, "error"));
  }

  /**
   * Resolve the current phase.
   *
   * The engine runs first, on memory only. Everything it implies (missed counters, civil disorder,
   * receipts, eliminations, the phase row, the next deadline, the saved game, the frames) is then
   * written in one transaction. If anything throws, storage rolls back, the game is restored from
   * its snapshot and the attempt counts as a failure: it is retried on a short bounded backoff and
   * then resolved with every unit holding, so a phase is never applied twice and never stuck.
   */
  private adjudicate(holdEverything = false): void {
    const meta = this.meta!;
    const game = this.game!;
    const phase = game.phase();
    const kind = this.phaseKind();
    const seats = this.seats();
    const orders: Record<string, string[]> = {};
    /** Human seats that ordered at least one unit themselves this phase. */
    const moved = new Set<PowerName>();
    /** Human seats that had something to order. */
    const expected = new Set<PowerName>();
    for (const seat of seats) {
      if (seat.eliminated === 1) continue;
      const stored = this.storedOrders(phase, seat.power);
      // Sealed defaults stand in for a present player's missing movement orders. A seat on
      // autopilot is covered by the bot, whose orders are already on file.
      const text = stored?.orders ?? (kind === "M" && seat.kind !== "ai" ? this.defaultOrders(seat.power) : []);
      // Re-validate every stored order on its own: one bad row must never stop the phase.
      const valid: string[] = [];
      for (const order of text) {
        try {
          valid.push(this.canonicalOwnOrder(order, kind, seat.power));
        } catch {
          // dropped; the unit is treated as unordered
        }
      }
      orders[seat.power] = valid;
      if (seat.kind === "human" || seat.kind === "civil_disorder") {
        if (canAct(game, seat.power)) expected.add(seat.power);
        if (stored?.source === "human" && valid.length > 0) moved.add(seat.power);
      }
    }
    const snapshot = game.toSaved(meta.id);
    try {
      this.atomic(() => {
        const outcome = holdEverything ? game.process({ orders: {} }) : this.resolvePhase(game, orders);
        this.applyOutcome(phase, kind, seats, orders, moved, expected, outcome, holdEverything);
      });
    } catch (error) {
      // `process` may have advanced the game before the throw. Put it back exactly as it was.
      this.game = Game.fromSaved(snapshot, meta.settings.rulebook);
      try {
        game.free();
      } catch {
        // already freed
      }
      this.adjudicationFailed(phase, error, holdEverything);
    }
  }

  private adjudicationFailed(phase: string, error: unknown, heldEverything: boolean): void {
    const meta = this.meta!;
    if (heldEverything) {
      // Even an empty order set will not resolve. End the game where it stands, loudly.
      this.log("adjudicate_gave_up", { error: String(error) }, "error");
      this.atomic(() => this.conclude("abandoned", [], "adjudication_failed"));
      return;
    }
    const attempts = (meta.retry?.attempts ?? 0) + 1;
    const delay = adjudicationRetryDelay(attempts);
    if (delay === null) {
      this.log("adjudicate_fallback_holds", { attempts, error: String(error) }, "error");
      this.atomic(() => {
        this.meta!.retry = null;
        this.broadcast(
          { t: "error", p: { code: "adjudication_fallback", message: `${phase} could not be adjudicated as ordered, so every unit held.` } },
          "ALL",
        );
      });
      this.adjudicate(true);
      return;
    }
    this.atomic(() => {
      this.meta!.retry = { attempts, at: Date.now() + delay };
      this.broadcast(
        { t: "error", p: { code: "adjudication_retry", message: `${phase} could not be adjudicated. Retrying shortly; orders can still be changed.` } },
        "ALL",
      );
    });
    this.log("adjudicate_retry_scheduled", { attempts, inMs: delay, error: String(error) }, "error");
  }

  /** Everything a resolved phase changes. Runs inside the adjudication transaction. */
  private applyOutcome(
    phase: string,
    kind: "M" | "R" | "A",
    seats: SeatRow[],
    orders: Record<string, string[]>,
    moved: Set<PowerName>,
    expected: Set<PowerName>,
    outcome: ReturnType<Game["process"]>,
    heldEverything: boolean,
  ): void {
    const meta = this.meta!;
    meta.retry = null;
    meta.aiDueAt = null;

    // No-moves-received: only movement phases count, and only for seats that had units to order.
    if (kind === "M") {
      for (const seat of seats) {
        if (!expected.has(seat.power)) continue;
        const missed = moved.has(seat.power) ? 0 : seat.missed + 1;
        const nextKind = missed >= LIMITS.civilDisorderAfter ? "civil_disorder" : "human";
        this.sql.exec("UPDATE seats SET missed = ?, kind = ? WHERE power = ?", missed, nextKind, seat.power);
        if (nextKind !== seat.kind) this.log(nextKind === "civil_disorder" ? "seat_civil_disorder" : "seat_recovered", { power: seat.power, missed });
      }
      meta.idlePhases = moved.size > 0 ? 0 : meta.idlePhases + 1;
    }
    this.sql.exec("INSERT INTO phases (name, results_json, adjudicated_at) VALUES (?, ?, ?)", phase, JSON.stringify(outcome), Date.now());

    // Receipts for every pledge made in this phase.
    const pledges = this.sql
      .exec<{ id: string; pledger: string; audience: string; orders_json: string }>(
        "SELECT id, pledger, audience, orders_json FROM pledges WHERE phase = ? AND receipt IS NULL",
        phase,
      )
      .toArray();
    for (const p of pledges) {
      const pledged = JSON.parse(p.orders_json) as string[];
      const receipt = pledgeReceipt(pledged, heldEverything ? [] : (orders[p.pledger] ?? []));
      this.sql.exec("UPDATE pledges SET receipt = ? WHERE id = ?", receipt, p.id);
      const frame: ServerMessage = { t: "pledge.receipt", p: { pledgeId: p.id, receipt, revealed: pledged } };
      if (p.audience === "ALL") this.broadcast(frame, "ALL");
      else {
        this.broadcast(frame, p.audience as PowerName);
        if (p.audience !== p.pledger) this.broadcast(frame, p.pledger as PowerName);
      }
    }

    // Eliminations, ready flags, and the votes and extension requests that belonged to the phase.
    const next = outcome.next;
    for (const seat of seats) {
      const units = next.units[seat.power]?.length ?? 0;
      const centers = next.centers[seat.power]?.length ?? 0;
      this.sql.exec("UPDATE seats SET ready = 0, eliminated = ? WHERE power = ?", units === 0 && centers === 0 ? 1 : 0, seat.power);
    }
    const hadVotes = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM votes").one().n > 0;
    this.sql.exec("DELETE FROM votes");
    this.sql.exec("DELETE FROM extension_requests WHERE phase = ?", phase);
    this.sql.exec("DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?", LIMITS.eventsKept);

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
    this.log("phase_adjudicated", { adjudicated: phase, heldEverything, moved: [...moved], idlePhases: meta.idlePhases });

    const after = this.seats();
    const survivors = after.filter((s) => s.eliminated === 0).map((s) => s.power);
    const humanPowersLeft = after.filter((s) => (s.kind === "human" || s.kind === "civil_disorder") && s.eliminated === 0);
    if (outcome.status !== "active") {
      const winner = outcome.status.startsWith("solo:") ? (outcome.status.slice(5) as PowerName) : null;
      this.conclude(winner ? "solo" : "draw", winner ? [winner] : survivors, winner ? "solo" : "engine_draw");
    } else if (humanPowersLeft.length === 0) {
      // Nobody human is left on the board. The game is over for its players: the survivors share it.
      this.game!.declareDraw();
      this.conclude("draw", survivors, "no_humans_left");
    } else if (meta.idlePhases >= LIMITS.abandonAfter) {
      this.conclude("abandoned", [], "no_orders");
    } else {
      this.startPhase();
      this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
      if (hadVotes) this.broadcast({ t: "votes", p: this.votesView() }, "ALL");
      this.broadcastState();
      this.kv.put("saved", this.game!.toSaved(meta.id));
    }
  }

  /**
   * End the game: finished (solo or draw) or abandoned. Writes the final state and the Registry
   * outbox entry and queues the closing frames. Runs inside the caller's transaction. The hand-off
   * itself happens afterwards, so a slow or failing Registry can never delay the last broadcast.
   */
  private conclude(result: GameResult, sharers: PowerName[], reason: string, index = true): void {
    const meta = this.meta!;
    const game = this.game!;
    const state = game.state();
    const centers: Record<string, number> = {};
    for (const p of POWERS) centers[p] = state.centers[p]?.length ?? 0;
    const share = new Set(sharers);
    const winners = result === "abandoned" ? [] : (POWERS.filter((p) => share.has(p) && (result === "solo" || centers[p]! > 0)) as PowerName[]);
    const scores: Record<string, number> =
      result === "solo"
        ? Object.fromEntries(POWERS.map((p) => [p, share.has(p) ? 1 : 0]))
        : result === "draw"
          ? sumOfSquares(Object.fromEntries(POWERS.map((p) => [p, share.has(p) ? centers[p]! : 0])))
          : {};
    const now = Date.now();
    meta.status = result === "abandoned" ? "abandoned" : "finished";
    meta.deadlineAt = null;
    meta.pause = null;
    meta.pauseReason = null;
    meta.retry = null;
    meta.aiDueAt = null;
    meta.finished = { result, winners, scores, reason };
    this.sql.exec("UPDATE seats SET ready = 0");
    this.kv.put("saved", game.toSaved(meta.id));
    if (index) {
      const record: GameRecord = {
        gameId: meta.id,
        result,
        reason,
        winners,
        scores,
        settings: meta.settings,
        cluster: ratingCluster(meta.settings),
        phaseCount: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM phases").one().n,
        createdAt: meta.createdAt,
        finishedAt: now,
        ledger: this.ledger(),
        seats: this.seats().map((s) => ({
          power: s.power,
          kind: s.kind,
          name: s.name,
          centers: centers[s.power] ?? 0,
          eliminated: s.eliminated === 1,
        })),
      };
      this.kv.put("registry-outbox", { record, attempts: 0, nextAt: now } satisfies Outbox);
      this.outboxAt = now;
    }
    this.broadcast({ t: "status", p: { status: meta.status, reason } }, "ALL");
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    this.broadcast({ t: "finished", p: { result, winners, scores, reason } }, "ALL");
    this.broadcastState();
    this.log(result === "abandoned" ? "game_abandoned" : "game_finished", { result, reason, winners });
  }

  /**
   * Hand the final summary to the Registry. The entry stays in storage until the Registry has
   * confirmed it; failures back off exponentially to an hourly ceiling and then stop with a log
   * line. Called from the alarm, never from the path that broadcasts the result.
   */
  private async flushOutbox(): Promise<void> {
    if (this.flushingOutbox) return;
    const entry = this.kv.get<Outbox>("registry-outbox");
    if (!entry || entry.gaveUp || !this.env.REGISTRY) {
      this.outboxAt = null;
      return;
    }
    this.flushingOutbox = true;
    try {
      const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName(REGISTRY_NAME));
      await registry.recordGame(entry.record);
      this.kv.delete("registry-outbox");
      this.outboxAt = null;
      this.log("registry_handoff", { result: entry.record.result, attempts: entry.attempts + 1 });
    } catch (error) {
      const attempts = entry.attempts + 1;
      const delay = outboxDelay(attempts);
      if (delay === null) {
        this.kv.put("registry-outbox", { ...entry, attempts, gaveUp: true } satisfies Outbox);
        this.outboxAt = null;
        this.log("registry_handoff_gave_up", { attempts, error: String(error) }, "error");
      } else {
        const nextAt = Date.now() + delay;
        this.kv.put("registry-outbox", { ...entry, attempts, nextAt } satisfies Outbox);
        this.outboxAt = nextAt;
        this.log("registry_handoff_failed", { attempts, retryInMs: delay, error: String(error) }, "error");
      }
    } finally {
      this.flushingOutbox = false;
    }
  }

  // ---------- Claude seats (RPC over the Durable Object binding; not reachable from the internet) ----------

  /** What a Claude seat needs for its turn, or null when the turn is stale or no longer wanted. */
  agentBrief(power: PowerName, phase: string): AgentBrief | null {
    const meta = this.meta;
    const game = this.game;
    if (!meta || !game || (meta.status !== "active" && meta.status !== "paused")) return null;
    if (game.phase() !== phase) return null;
    const seat = this.seat(power);
    if (!seat || seat.kind !== "ai" || seat.eliminated === 1 || seat.ready === 1) return null;
    const ledger = this.ledger();
    return {
      gameId: meta.id,
      power,
      phase,
      state: game.state() as StateView,
      press: this.pressFor(power, phase),
      trust: Object.fromEntries(Object.entries(ledger).map(([p, l]) => [p, { kept: l.kept, broken: l.broken }])),
    };
  }

  /**
   * Apply a Claude seat's turn. `null` means the model had nothing usable, so the bot's orders
   * stand. A turn for a phase that has already resolved is refused, never applied late.
   */
  agentSubmit(power: PowerName, phase: string, decision: AgentDecision | null): { applied: boolean; reason: string } {
    const meta = this.meta;
    const game = this.game;
    try {
      if (!meta || !game || (meta.status !== "active" && meta.status !== "paused")) return { applied: false, reason: "not_active" };
      if (game.phase() !== phase) return { applied: false, reason: "stale_phase" };
      const seat = this.seat(power);
      if (!seat || seat.kind !== "ai" || seat.eliminated === 1) return { applied: false, reason: "not_an_ai_seat" };
      if (seat.ready === 1) return { applied: false, reason: "turn_already_closed" };
      let applied = false;
      if (decision) {
        const outcome = this.setOrders(power, phase, decision.orders.slice(0, 34), "claude");
        applied = "accepted" in outcome && outcome.accepted.length > 0;
        const accepted = "accepted" in outcome ? outcome.accepted : [];
        if (meta.status === "active") {
          for (const message of decision.messages.slice(0, LIMITS.agentMessages)) {
            const to = message.to.trim().toUpperCase();
            const body = message.body.trim().slice(0, LIMITS.agentBodyChars);
            if (!body || (to !== "ALL" && !(POWERS as readonly string[]).includes(to)) || to === power) continue;
            const pledged = decision.pledge?.to.trim().toUpperCase() === to ? decision.pledge.orders.filter((o) => accepted.includes(o)) : [];
            this.press(
              power,
              to as PowerName | "ALL",
              body,
              pledged.length > 0 ? { orders: pledged, sealed: decision.pledge!.sealed } : undefined,
            );
          }
        }
      }
      this.atomic(() => {
        this.sql.exec("UPDATE seats SET ready = 1 WHERE power = ?", power);
        const waiting = this.seats().some((s) => s.kind === "ai" && s.eliminated === 0 && s.ready === 0 && canAct(game, s.power));
        if (!waiting) meta.aiDueAt = null;
        this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
      });
      this.advance();
      return { applied, reason: applied ? "ok" : "bot_orders_stand" };
    } finally {
      if (this.meta) this.settle();
    }
  }
}

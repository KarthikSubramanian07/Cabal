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
 *  - Every AI seat is played every phase through a `SeatBrain`. The bot's orders are on file the
 *    moment a phase opens. A game that opted into Claude then asks the queue for better ones, in
 *    two bounded steps (negotiate, then order), under a hard spend cap; whatever goes wrong, the
 *    orders on file stand and the phase resolves on time.
 */
import { DurableObject } from "cloudflare:workers";
import {
  type GameListing,
  type GamePlayerRecord,
  type GameRecord,
  type GameResult,
  type GameSettings as Settings,
  GameSettings,
  type GameSummary,
  type LedgerEntry,
  type OrderResultView,
  type OrderVerdict,
  PROTOCOL_VERSION,
  QUOTE_CHARS,
  type PhaseSummary,
  type PledgeView,
  type PowerName,
  type PressQuote,
  type PressView,
  type Receipt,
  type ReplayExtension,
  type SeatView,
  type ServerMessage,
  type StateView,
  type VotesView,
  drawScores,
  excerpt,
  parseClientMessage,
  ratingCluster,
} from "@cabal/protocol";
import { adjudicateStrict, restoreGame } from "./adjudicate-guard.js";
import { DEFAULT_MODEL, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, MEMORY_LIMITS, type Memory, type Usage, costMicros, maxCallCostMicros } from "@cabal/agents";
import { canAct } from "./bot.js";
import { seatBrain } from "./brain.js";
import {
  AGENT_CALL_TTL_MS,
  AI_TURN_LIMIT_MS,
  NEGOTIATE_LIMIT_MS,
  NEGOTIATE_MIN_PHASE_MS,
  PAUSE_LIMIT_MS,
  LOBBY_TTL_MS,
  adjudicationRetryDelay,
  alarmBackoff,
  listenMs,
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
  randomNonce,
  timedFirst,
} from "./engine.js";
import { gameIndex } from "./game-index.js";
import { REQUEST_ID_HEADER, log, newRequestId, requestIdFrom, withLogContext } from "./log.js";
import { type Notice, deliver, notices, pushEnabled, reminderMinutes } from "./notify.js";
import { hashToken, mintToken, parseToken, randomId, sameHash } from "./tokens.js";
import { ledgerTally } from "./ratings.js";
import { checkPledge, judgeOrders } from "./validate.js";

type Status = "lobby" | "active" | "paused" | "finished" | "abandoned";

/** What a seat is called once the player who held it has deleted their account. */
export const GHOST_NAME = "Ghost";

/** A room's answer to `/forsake`: the seats the deleted player left, and whether the game was still a lobby. */
export interface ForsakeAnswer {
  gameId: string;
  seats: PowerName[];
  unplayed: boolean;
}

/** Abuse limits. A room is single threaded, so every unbounded input is a way to stall a game. */
export const LIMITS = {
  /** Token bucket per socket: burst size and refill per second. */
  burst: 30,
  refillPerSecond: 10,
  /** A `sync` reads up to a page of events and a `hello` builds a whole welcome, so they cost more than an ordinary frame. */
  syncCost: 5,
  helloCost: 5,
  /** Largest client frame, in bytes: room for the longest press body (4,000 characters) in any script. */
  frameBytes: 16_384,
  /** Press messages one power may send in one phase. */
  pressPerPhase: 60,
  /** Events replayed by one `sync` request; clients page with `since`. */
  syncPage: 500,
  /** Press messages included in a welcome frame (the most recent ones). */
  welcomePress: 500,
  /** Press messages in one page of `GET /press`: the default and the most a caller may ask for. */
  pressPage: 100,
  pressPageMax: 200,
  /** Resolved phases listed in a welcome frame and a summary (the most recent ones). */
  historyPhases: 400,
  /** Sockets that have not bound to a seat. When the room is full the oldest of them makes way. */
  spectators: 200,
  /** Sockets one seat may hold open (several tabs and devices). */
  socketsPerSeat: 8,
  /** Extra seat tokens a signed-in player may hold for one seat (one per device). */
  tokensPerSeat: 8,
  /** Stored broadcast frames kept for `sync`: frames numbered this far behind the newest are gone. */
  eventsKept: 4000,
  /** Times one seat may change its ready flag or its ballot in one phase. */
  changesPerPhase: 40,
  /** Consecutive missed movement phases before a seat is in civil disorder. */
  civilDisorderAfter: 2,
  /** Consecutive missed movement phases before a seat is vacant and may be given to a substitute. */
  vacantAfter: 4,
  /** Consecutive movement phases with no human order before the game is abandoned. */
  abandonAfter: 3,
  /** Phases one trigger may resolve in a row (bot-only retreats and builds chain through). */
  chain: 4,
  /** Claude turns (one seat, one phase) per game unless `CLAUDE_TURNS_PER_GAME` says otherwise. */
  claudeTurnsPerGame: 400,
  /** What one game may spend on Claude, in US dollars, unless `CLAUDE_USD_PER_GAME` says otherwise. */
  claudeUsdPerGame: 5,
  /** Model failures in a row before a game stops asking Claude and plays on with the bot. */
  claudeStrikes: 6,
  /** Press an AI seat may send in one step, and the longest body. */
  agentMessages: 3,
  agentBodyChars: 1000,
  /** Press handed to a Claude seat: this phase's, and what it sent or received before. */
  briefPress: 60,
  briefEarlierPress: 20,
  /** Settled model calls kept for the record. */
  agentCallsKept: 600,
} as const;

/** The model behind Claude seats. Prices and the spend cap are worked out for this model. */
export const CLAUDE_MODEL = DEFAULT_MODEL;

/**
 * The most one model call can cost, reserved against the game's budget before the call is made.
 * It assumes the prompt bound the brain enforces (in UTF-8 bytes, and a token is never shorter
 * than a byte) and the whole output allowance, so a reservation is never smaller than the bill.
 */
export function reservationMicros(kind: "M" | "R" | "A", step: Step): number {
  const output = kind === "R" ? MAX_OUTPUT_TOKENS.retreat : kind === "A" ? MAX_OUTPUT_TOKENS.adjustment : step === "negotiate" ? MAX_OUTPUT_TOKENS.negotiate : MAX_OUTPUT_TOKENS.movement;
  return maxCallCostMicros(CLAUDE_MODEL, MAX_INPUT_TOKENS, output);
}

type Step = AgentTurn["step"];

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
  /** When that grace period began: orders filed after it were late. */
  graceFrom: number | null;
  /** Consecutive movement phases in which no human submitted an order. */
  idlePhases: number;
  /** Set while a failed adjudication waits for its next attempt. */
  retry: { attempts: number; at: number } | null;
  /** Set while Claude seats are still thinking about the current phase: when the room stops waiting. */
  aiDueAt: number | null;
  /**
   * Where the Claude seats are in the current phase: talking, waiting for the table to answer, or
   * ordering. `listenUntil` is when the wait ends by itself. Null when no Claude turn is open.
   */
  ai: { step: "negotiate" | "listen" | "order"; listenUntil: number } | null;
  /** Claude turns (one seat, one phase) requested so far, against the per-game cap. */
  claudeTurns: number;
  /** Model calls put on the queue so far. */
  claudeCalls: number;
  /** What the game has spent on Claude, in micro-dollars, from the usage each call reported. */
  claudeSpentMicros: number;
  /** Tokens behind that spend. */
  claudeTokens: Usage;
  /** Model failures in a row. */
  claudeStrikes: number;
  /** Why this game stopped asking Claude, once it has. The bot plays on. */
  claudeOff: string | null;
  /**
   * Whether the index has given this game a place under the deployment's Claude budget. Null until
   * it has been asked. No model call is ever reserved without `admitted`.
   */
  claudeAdmission: "admitted" | "refused" | null;
  /** The phase whose deadline reminder has gone out, so a player is reminded once per phase. */
  remindedPhase: string | null;
}

interface Outbox {
  record: GameRecord;
  /** Set when the game held a place under the Claude budget: what it committed, to hand the rest back. */
  claude?: { committedMicros: number };
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
  /** The signed-in player holding the seat; null for anonymous play and AI. */
  player_id: string | null;
}

/** One holder's time at a seat. A seat that changed hands has one row per holder. */
interface StintRow extends Record<string, SqlStorageValue> {
  power: PowerName;
  stint: number;
  player_id: string | null;
  name: string | null;
  joined_at: number;
  substitute: number;
  left_reason: string | null;
  due: number;
  on_time: number;
  late: number;
}

/** A signed-in player, as the router vouches for them. Rooms are reachable only through the router. */
interface Signed {
  id: string;
  handle: string;
}

interface Attachment {
  /** Null until a `hello` frame binds the socket to a seat. */
  power: PowerName | null;
  /** When the socket was accepted. */
  at?: number;
}

/** What a Claude seat needs to decide one step of a turn. Served over the Durable Object binding only. */
export interface AgentBrief {
  gameId: string;
  power: PowerName;
  phase: string;
  step: Step;
  state: StateView;
  /** Press of this phase that the seat may read, oldest first. */
  press: PressView[];
  /** What the seat sent or received in earlier phases, oldest first. */
  earlierPress: { phase: string; from: string; to: string; body: string }[];
  trust: Record<string, { kept: number; broken: number }>;
  /** The seat's own diary and relationships, as it left them last turn. */
  memory: Memory;
  deadlineAt: number | null;
}

export interface AgentDecision {
  orders: string[];
  messages: { to: string; body: string }[];
  pledge: { to: string; orders: string[]; sealed: boolean } | null;
}

/** What the model call behind a submission cost, and what the seat wants remembered. */
export interface AgentReport {
  model: string | null;
  usage: Usage | null;
  /** `yes`: usage is the bill. `no`: nothing was billed. `unknown`: assume the worst. */
  billed: "yes" | "no" | "unknown";
  /** Set when the model call failed; a 401 or 403 stops the game asking again. */
  failure?: { status: number | null; message: string } | null;
  memory?: Memory | null;
}

/** What became of each part of a submission. One bad part never discards the others. */
export interface AgentOutcome {
  applied: boolean;
  reason: string;
  orders: { accepted: string[]; rejected: { text: string; reason: string }[] };
  messages: { to: string; sent: boolean; code: string | null }[];
  /** `sent` with a message, `dropped` when its orders or its message were refused, null when none was offered. */
  pledge: "sent" | "dropped" | null;
}

interface CallRow extends Record<string, SqlStorageValue> {
  phase: string;
  power: PowerName;
  step: Step;
  reserved_micros: number;
  dispatched_at: number | null;
  claimed_at: number | null;
  cost_micros: number | null;
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
  pledge_id TEXT,
  quote_id TEXT
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
  adjudicated_at INTEGER NOT NULL,
  summary_json TEXT
);
CREATE TABLE IF NOT EXISTS press_reads (
  power TEXT NOT NULL,
  thread TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (power, thread)
);
CREATE TABLE IF NOT EXISTS agent_memory (
  power TEXT PRIMARY KEY,
  memory_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_calls (
  phase TEXT NOT NULL,
  power TEXT NOT NULL,
  step TEXT NOT NULL,
  reserved_micros INTEGER NOT NULL,
  dispatched_at INTEGER,
  claimed_at INTEGER,
  cost_micros INTEGER,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  PRIMARY KEY (phase, power, step)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  snapshot TEXT
);
CREATE TABLE IF NOT EXISTS seat_changes (
  power TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  n INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stints (
  power TEXT NOT NULL,
  stint INTEGER NOT NULL,
  player_id TEXT,
  name TEXT,
  joined_at INTEGER NOT NULL,
  substitute INTEGER NOT NULL DEFAULT 0,
  left_reason TEXT,
  due INTEGER NOT NULL DEFAULT 0,
  on_time INTEGER NOT NULL DEFAULT 0,
  late INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (power, stint)
);
CREATE TABLE IF NOT EXISTS seat_tokens (
  token_hash TEXT PRIMARY KEY,
  power TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- One push per sender, recipient and phase: the first private dispatch to an away player tells
-- them mail is waiting; the rest of that phase's dispatches from the same power are silent.
CREATE TABLE IF NOT EXISTS press_notices (
  phase TEXT NOT NULL,
  recipient TEXT NOT NULL,
  sender TEXT NOT NULL,
  PRIMARY KEY (phase, recipient, sender)
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
  /** Push notices to deliver once the current change has committed. */
  private notices: Notice[] = [];
  /** The game's public listing is out of date and is refreshed once the current change has committed. */
  private listingDirty = false;
  /** Which seats can act, worked out once per position. */
  private actCache: { game: Game; phase: string; by: Map<string, boolean> } | null = null;
  /** Per-socket rate limit buckets. In memory only: hibernation resets them, which is harmless. */
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();
  /** Alarm handlers that failed in a row, and the earliest instant the next one may run. */
  private alarmFailures = 0;
  private alarmNotBefore: number | null = null;
  /** True while the index is being asked for a place under the Claude budget. */
  private admitting = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered by the runtime without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Waking is work too: its lines (the engine's cold start among them) say they are the room's.
    ctx.blockConcurrencyWhile(() => withLogContext({ service: "room", requestId: newRequestId("wake") }, async () => {
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
        graceFrom: stored.graceFrom ?? null,
        idlePhases: stored.idlePhases ?? 0,
        retry: stored.retry ?? null,
        aiDueAt: stored.aiDueAt ?? null,
        ai: stored.ai ?? null,
        claudeTurns: stored.claudeTurns ?? 0,
        claudeCalls: stored.claudeCalls ?? 0,
        claudeSpentMicros: stored.claudeSpentMicros ?? 0,
        claudeTokens: stored.claudeTokens ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        claudeStrikes: stored.claudeStrikes ?? 0,
        claudeOff: stored.claudeOff ?? null,
        claudeAdmission: stored.claudeAdmission ?? null,
        remindedPhase: stored.remindedPhase ?? null,
      };
      this.meta = meta;
      const saved = this.kv.get<string>("saved");
      // Trusted restore: the stored record is resumed, never adjudicated again, so an engine
      // upgrade that corrects a ruling cannot stop a game in flight from waking.
      this.game = timedFirst("firstGameMs", () => (saved ? Game.resume(saved, meta.settings.rulebook) : new Game(meta.settings.rulebook)));
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
    }));
  }

  /** Create the tables, then bring rooms from older deployments up to the current shape. */
  private migrate(): void {
    this.sql.exec(SCHEMA);
    const has = (table: string, column: string) =>
      this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().some((c) => c.name === column);
    if (!has("orders", "source")) this.sql.exec("ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'human'");
    if (!has("votes", "include_json")) this.sql.exec("ALTER TABLE votes ADD COLUMN include_json TEXT");
    if (!has("phases", "summary_json")) this.sql.exec("ALTER TABLE phases ADD COLUMN summary_json TEXT");
    if (!has("events", "snapshot")) this.sql.exec("ALTER TABLE events ADD COLUMN snapshot TEXT");
    if (!has("seats", "player_id")) this.sql.exec("ALTER TABLE seats ADD COLUMN player_id TEXT");
    if (!has("pledges", "pledger_player")) this.sql.exec("ALTER TABLE pledges ADD COLUMN pledger_player TEXT");
    if (!has("pledges", "audience_player")) this.sql.exec("ALTER TABLE pledges ADD COLUMN audience_player TEXT");
    if (!has("press", "quote_id")) this.sql.exec("ALTER TABLE press ADD COLUMN quote_id TEXT");
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_snapshot ON events(snapshot, audience) WHERE snapshot IS NOT NULL");
    // AI seats no longer hold bearer tokens: the Durable Object binding is the credential.
    this.sql.exec("DROP TABLE IF EXISTS agent_tokens");
    this.sql.exec("UPDATE seats SET token_hash = NULL WHERE kind = 'ai'");
  }

  private log(event: string, fields: Record<string, unknown> = {}, level: "info" | "error" = "info"): void {
    log(event, { gameId: this.meta?.id ?? null, phase: this.game?.phase() ?? null, ...fields }, level);
  }

  /** Run one piece of incoming work with its log lines tagged: the room, and the request behind it. */
  private traced<T>(requestId: string, work: () => T): T {
    return withLogContext({ service: "room", requestId }, work);
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
    const noticesBefore = this.notices.length;
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
      this.notices.length = noticesBefore;
      this.outboxAt = outboxBefore;
      throw error;
    }
  }

  private alarmAt(): number | null {
    if (!this.meta) return null;
    const at = nextAlarmAt({
      status: this.meta.status,
      createdAt: this.meta.createdAt,
      deadlineAt: this.meta.deadlineAt,
      retryAt: this.meta.retry?.at ?? null,
      aiDueAt: this.meta.aiDueAt,
      pausedUntil: this.meta.pause?.until ?? null,
      outboxAt: this.outboxAt,
      reminderAt: this.reminderAt(),
    });
    // After a failed alarm the next one waits out its backoff, however overdue the work is.
    return at !== null && this.alarmNotBefore !== null ? Math.max(at, this.alarmNotBefore) : at;
  }

  /**
   * When to remind the players who have not ordered yet: `PUSH_REMINDER_MINUTES` before the
   * deadline, once per phase, and only for phases at least twice that long (in a short phase the
   * players have only just been told it opened). Null when push is not configured.
   */
  private reminderAt(): number | null {
    const meta = this.meta;
    const game = this.game;
    if (!meta || !game || meta.status !== "active" || meta.retry || meta.deadlineAt === null || !pushEnabled(this.env)) return null;
    const phase = game.phase();
    if (meta.remindedPhase === phase || meta.gracePhase === phase) return null;
    const leadMs = reminderMinutes(this.env) * 60_000;
    if (phaseSeconds(phase, meta.settings) * 1000 < 2 * leadMs) return null;
    return meta.deadlineAt - leadMs;
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
    const told = this.notices.splice(0);
    if (told.length > 0) this.ctx.waitUntil(deliver(this.env, told));
    const turns = this.turns.splice(0);
    if (turns.length > 0) this.ctx.waitUntil(this.dispatchTurns(turns));
    if (this.listingDirty) {
      this.listingDirty = false;
      this.ctx.waitUntil(this.pushListing());
    }
    // A running game that only now wants Claude (a key set after it started) asks for its place here.
    const meta = this.meta;
    if (meta?.status === "active" && meta.claudeAdmission === null && meta.claudeOff === null && !this.admitting && this.brain().deliberates) {
      this.ctx.waitUntil(this.admitClaude().then(() => this.settle()));
    }
  }

  // ---------- the public listing (public games only) ----------

  /** Note that what the index says about this game has changed. Unlisted games never leave their room. */
  private touchListing(): void {
    if (this.meta?.settings.visibility === "public") this.listingDirty = true;
  }

  private listing(): GameListing {
    const meta = this.meta!;
    const seats = this.seats();
    return {
      gameId: meta.id,
      status: meta.status as GameListing["status"],
      settings: meta.settings,
      cluster: ratingCluster(meta.settings),
      hostName: seats.find((s) => s.power === meta.creator)?.name ?? null,
      humans: seats.filter((s) => s.kind === "human" || s.kind === "civil_disorder").length,
      openSeats: seats.filter((s) => s.kind === "open").length,
      phase: this.game!.phase(),
      deadlineAt: meta.deadlineAt,
      createdAt: meta.createdAt,
      updatedAt: Date.now(),
    };
  }

  /**
   * Refresh or remove this game's row in the index. Best effort: the listing is a convenience, a
   * failure is logged and the next change tries again, and the index ignores rows that go stale.
   */
  private async pushListing(): Promise<void> {
    const index = gameIndex(this.env);
    const meta = this.meta;
    if (!index || !meta) return;
    try {
      if (meta.status === "lobby" || meta.status === "active" || meta.status === "paused") await index.upsertListing(this.listing());
      else await index.removeListing(meta.id);
    } catch (error) {
      this.log("listing_failed", { error: String(error) }, "error");
    }
  }

  override alarm(): Promise<void> {
    return this.traced(requestIdFrom(null, "alarm"), () => this.onAlarm());
  }

  private async onAlarm(): Promise<void> {
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
        this.aiTimeout();
      }
      if (this.meta.status === "active") {
        if (this.meta.retry) {
          if (now >= this.meta.retry.at) this.adjudicate();
        } else if (this.meta.deadlineAt !== null && now >= this.meta.deadlineAt) {
          this.onDeadline();
        } else {
          const remindAt = this.reminderAt();
          if (remindAt !== null && now >= remindAt) this.atomic(() => this.remind());
        }
      }
      this.alarmFailures = 0;
      this.alarmNotBefore = null;
    } catch (error) {
      // Never let the runtime retry an alarm blind: log, re-arm from durable state, carry on. The
      // work is still overdue, so without a backoff the next alarm would fire at once, for ever.
      this.alarmFailures += 1;
      const delay = alarmBackoff(this.alarmFailures);
      this.alarmNotBefore = Date.now() + delay;
      this.log("alarm_failed", { error: String(error), failures: this.alarmFailures, retryInMs: delay }, "error");
    } finally {
      this.settle();
    }
  }

  // ---------- HTTP entry (called by the router) ----------

  override fetch(request: Request): Promise<Response> {
    return this.traced(requestIdFrom(request.headers.get(REQUEST_ID_HEADER)), () => this.handle(request));
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/create") return await this.create(request);
      if (request.method === "POST" && path === "/join") return await this.join(request);
      if (request.method === "POST" && path === "/start") return await this.start(request);
      if (request.method === "POST" && path === "/substitute") return await this.inviteSubstitute(request);
      if (request.method === "POST" && path === "/seat") return await this.seatToken(request);
      if (request.method === "POST" && path === "/forsake") return await this.forsake(request);
      if (request.method === "GET" && path === "/summary") {
        if (!this.meta) return bad("no such game", 404);
        return json(this.summary());
      }
      if (request.method === "GET" && path === "/ledger") {
        if (!this.meta) return bad("no such game", 404);
        const viewer = this.authorise(bearer(request));
        return json({ gameId: this.meta.id, ledger: this.ledger(), entries: this.ledgerEntries(viewer) });
      }
      if (request.method === "GET" && path === "/replay") {
        if (!this.game || !this.meta) return bad("no such game", 404);
        return json(this.replay(this.authorise(bearer(request))));
      }
      if (request.method === "GET" && path === "/centres") {
        // The board is public: the same centres every spectator sees, without the whole saved game.
        if (!this.game || !this.meta) return bad("no such game", 404);
        return json({ gameId: this.meta.id, phase: this.game.phase(), centers: this.game.state().centers });
      }
      if (request.method === "GET" && path === "/press") {
        if (!this.meta) return bad("no such game", 404);
        return this.pressHistoryPage(request);
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
    const body = (await request.json()) as { id: string; name: string; settings: Settings; player?: Signed };
    const settings = GameSettings.parse(body.settings);
    const creator = POWERS[Math.floor(Math.random() * POWERS.length)] as PowerName;
    const token = mintToken(body.id, creator);
    // A signed-in player always sits under their handle.
    const player = body.player ?? null;
    const name = player?.handle ?? body.name;
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
        graceFrom: null,
        idlePhases: 0,
        retry: null,
        aiDueAt: null,
        ai: null,
        claudeTurns: 0,
        claudeCalls: 0,
        claudeSpentMicros: 0,
        claudeTokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        claudeStrikes: 0,
        claudeOff: null,
        claudeAdmission: null,
        remindedPhase: null,
      };
      this.game = timedFirst("firstGameMs", () => new Game(settings.rulebook));
      for (const p of POWERS) this.sql.exec("INSERT INTO seats (power, kind) VALUES (?, 'open')", p);
      this.sql.exec("UPDATE seats SET kind = 'human', name = ?, token_hash = ?, player_id = ? WHERE power = ?", name, hashToken(token), player?.id ?? null, creator);
      this.openStint(creator, player, name, false);
      this.kv.put("saved", this.game.toSaved(body.id));
    });
    this.noteSeat(creator, player, name, false);
    this.touchListing();
    this.log("game_created", { pacing: settings.pacing, press: settings.press, aiBrain: settings.aiBrain, visibility: settings.visibility });
    return json({ gameId: body.id, token, power: creator });
  }

  private async join(request: Request): Promise<Response> {
    if (!this.meta) return bad("no such game", 404);
    let meta = this.meta;
    const body = (await request.json()) as { name: string; power?: PowerName; invite?: string; player?: Signed };
    const player = body.player ?? null;
    const name = player?.handle ?? body.name;
    // One player, one seat: a caller who already holds a seat here cannot take another. A signed-in
    // player is known by who they are, whatever token they send, and a seat once left stays left.
    if (this.authorise(bearer(request))) return bad("you already hold a seat in this game", 409);
    // The join that fills the table starts the game, so the Claude budget is asked first.
    if (meta.status === "lobby" && this.seats().filter((s) => s.kind === "open").length === 1) await this.admitClaude();
    // The room may have moved on during the awaits above: read it again.
    if (!this.meta) return bad("no such game", 404);
    meta = this.meta;
    // Checked after the last await, so two joins by one player can never both pass it.
    if (player && this.playedHere(player.id)) return bad("you already hold, or have held, a seat in this game", 409);
    // Everything from here to the write is synchronous, so two joins can never pick the same seat.
    if (meta.status === "lobby") {
      const open = this.seats().filter((s) => s.kind === "open");
      const chosen = (body.power && open.find((s) => s.power === body.power)) ?? open[Math.floor(Math.random() * open.length)];
      if (!chosen) return bad("no open seats", 409);
      const token = mintToken(meta.id, chosen.power);
      this.atomic(() => {
        this.sql.exec(
          "UPDATE seats SET kind = 'human', name = ?, token_hash = ?, player_id = ?, missed = 0, ready = 0 WHERE power = ?",
          name,
          hashToken(token),
          player?.id ?? null,
          chosen.power,
        );
        this.openStint(chosen.power, player, name, false);
        this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
        if (this.seats().every((s) => s.kind !== "open")) this.begin();
      });
      this.noteSeat(chosen.power, player, name, false);
      this.touchListing();
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
        "UPDATE seats SET kind = 'human', name = ?, token_hash = ?, player_id = ?, missed = 0, ready = 0 WHERE power = ?",
        name,
        hashToken(token),
        player?.id ?? null,
        seat.power,
      );
      this.sql.exec("DELETE FROM substitute_invites WHERE power = ?", seat.power);
      // Every token the previous holder had, on any device, dies with the seat.
      this.sql.exec("DELETE FROM seat_tokens WHERE power = ?", seat.power);
      this.openStint(seat.power, player, name, true);
      this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    });
    this.noteSeat(seat.power, player, name, true);
    // The previous owner's token is dead, so their open sockets must go with it.
    this.closeSeatSockets(seat.power, 4001, "seat reassigned");
    this.touchListing();
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

  /**
   * A fresh seat token for a signed-in player's own seat, for another device or after a cleared
   * browser. Tokens the seat already has keep working; the oldest make way past the cap.
   */
  private async seatToken(request: Request): Promise<Response> {
    if (!this.meta) return bad("no such game", 404);
    const body = (await request.json()) as { player?: Signed };
    const player = body.player;
    if (!player) return bad("sign in to recover a seat", 401);
    const seat = this.seats().find((s) => s.player_id === player.id && (s.kind === "human" || s.kind === "civil_disorder"));
    if (!seat) return bad("you hold no seat in this game", 404);
    const token = mintToken(this.meta.id, seat.power);
    this.atomic(() => {
      this.sql.exec("INSERT INTO seat_tokens (token_hash, power, created_at) VALUES (?, ?, ?)", hashToken(token), seat.power, Date.now());
      this.sql.exec(
        "DELETE FROM seat_tokens WHERE power = ? AND token_hash NOT IN (SELECT token_hash FROM seat_tokens WHERE power = ? ORDER BY created_at DESC, token_hash LIMIT ?)",
        seat.power,
        seat.power,
        LIMITS.tokensPerSeat,
      );
    });
    this.log("seat_token_issued", { power: seat.power });
    return json({ gameId: this.meta.id, token, power: seat.power });
  }

  /**
   * A player deleted their account. Every trace of who they were leaves this room: their seat
   * becomes a ghost by the game's own rules, and their name and id go from the seat, its stints,
   * its pledges and a hand-off still waiting for the index. In a lobby the seat opens again (and a
   * lobby left with nobody in it ends); in a running game the seat is in civil disorder, at once
   * vacant for a substitute and played by the bot where the table asked for AI fill; in an ended
   * game only the name goes. Their tokens die and their sockets close. Idempotent. Called by the
   * router over the Durable Object binding only (`/forsake` is not a public route).
   */
  private async forsake(request: Request): Promise<Response> {
    if (!this.meta) return bad("no such game", 404);
    const { playerId } = (await request.json()) as { playerId?: string };
    if (!playerId) return bad("no player named", 400);
    const held = this.seats().filter((s) => s.player_id === playerId);
    const stints = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM stints WHERE player_id = ?", playerId).one().n;
    // `unplayed`: the game had not begun, so the room keeps no stint of theirs and the index should
    // drop its rows for them here rather than keep an anonymous holder of a seat that opened again.
    if (held.length === 0 && stints === 0) return json({ gameId: this.meta.id, seats: [], unplayed: this.meta.status === "lobby" } satisfies ForsakeAnswer);
    const status = this.meta.status;
    this.atomic(() => {
      for (const seat of held) {
        if (status === "lobby") {
          this.sql.exec("UPDATE seats SET kind = 'open', name = NULL, token_hash = NULL, player_id = NULL, ready = 0, missed = 0 WHERE power = ?", seat.power);
        } else if ((status === "active" || status === "paused") && seat.eliminated === 0 && seat.kind !== "ai") {
          this.sql.exec(
            "UPDATE seats SET kind = 'civil_disorder', name = ?, token_hash = NULL, player_id = NULL, ready = 0, missed = MAX(missed, ?) WHERE power = ?",
            GHOST_NAME,
            LIMITS.vacantAfter,
            seat.power,
          );
          // Where the table fills seats with AI the bot takes the ghost's turn at once, so the phase
          // never waits on a player who is not coming back.
          const ghost = this.seat(seat.power)!;
          if (status === "active" && this.autopilot(ghost) && canAct(this.game!, seat.power)) {
            const phase = this.game!.phase();
            this.writeOrders(phase, seat.power, this.brain().orders(this.game!, seat.power, this.meta!.id), "bot");
            this.sql.exec("UPDATE seats SET ready = 1 WHERE power = ?", seat.power);
          }
        } else {
          this.sql.exec("UPDATE seats SET name = ?, token_hash = NULL, player_id = NULL WHERE power = ?", GHOST_NAME, seat.power);
        }
        this.sql.exec("DELETE FROM seat_tokens WHERE power = ?", seat.power);
      }
      // A lobby seat that opens again was never played: its stint goes, rather than staying anonymous.
      // Its number is never handed out again, though: the index may still hold a row under it, and
      // the next holder's row must not collide with that one (see `nextStint`).
      if (status === "lobby") {
        const dropped = this.sql.exec<{ power: PowerName; n: number }>("SELECT power, MAX(stint) AS n FROM stints WHERE player_id = ? GROUP BY power", playerId).toArray();
        if (dropped.length > 0) {
          const floor: Partial<Record<PowerName, number>> = { ...this.kv.get<Partial<Record<PowerName, number>>>("stint-floor") };
          for (const d of dropped) floor[d.power] = Math.max(floor[d.power] ?? 0, d.n + 1);
          this.kv.put("stint-floor", floor);
        }
        this.sql.exec("DELETE FROM stints WHERE player_id = ?", playerId);
      }
      this.sql.exec("UPDATE stints SET player_id = NULL, name = ? WHERE player_id = ?", GHOST_NAME, playerId);
      this.sql.exec("UPDATE pledges SET pledger_player = NULL WHERE pledger_player = ?", playerId);
      this.sql.exec("UPDATE pledges SET audience_player = NULL WHERE audience_player = ?", playerId);
      const outbox = this.kv.get<Outbox>("registry-outbox");
      if (outbox) {
        const powers = new Set(outbox.record.players?.filter((p) => p.playerId === playerId).map((p) => p.power) ?? []);
        const record: GameRecord = {
          ...outbox.record,
          seats: outbox.record.seats.map((s) => (powers.has(s.power) || held.some((h) => h.power === s.power) ? { ...s, name: GHOST_NAME } : s)),
          ...(outbox.record.players
            ? { players: outbox.record.players.map((p) => (p.playerId === playerId ? { ...p, playerId: null, name: GHOST_NAME } : p)) }
            : {}),
        };
        this.kv.put("registry-outbox", { ...outbox, record } satisfies Outbox);
      }
      if (status === "lobby") {
        const seated = this.seats().filter((s) => s.kind === "human");
        if (seated.length === 0) {
          this.conclude("abandoned", [], "lobby_emptied", false);
          return;
        }
        // The host left: whoever sat down first after them can start the game now.
        if (held.some((s) => s.power === this.meta!.creator)) {
          const first = this.sql
            .exec<{ power: PowerName }>("SELECT power FROM stints WHERE left_reason IS NULL AND power IN (SELECT power FROM seats WHERE kind = 'human') ORDER BY joined_at, power LIMIT 1")
            .toArray()[0];
          this.meta!.creator = first?.power ?? seated[0]!.power;
        }
      }
      if (held.length > 0) this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    });
    for (const seat of held) this.closeSeatSockets(seat.power, 4001, "seat reassigned");
    if (held.length > 0) this.touchListing();
    if (status === "active" && held.length > 0) this.advance();
    this.log("player_departed", { seats: held.map((s) => s.power), status });
    return json({ gameId: this.meta.id, seats: held.map((s) => s.power), unplayed: status === "lobby" } satisfies ForsakeAnswer);
  }

  /** True when this player holds or has held any seat in this game. */
  private playedHere(playerId: string): boolean {
    return (
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM stints WHERE player_id = ?", playerId).one().n > 0 ||
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM seats WHERE player_id = ?", playerId).one().n > 0
    );
  }

  /** Start a holder's stint at a seat, closing the previous holder's. Runs inside the caller's transaction. */
  private openStint(power: PowerName, player: Signed | null, name: string, substitute: boolean): number {
    const stint = this.nextStint(power);
    this.sql.exec("UPDATE stints SET left_reason = 'replaced' WHERE power = ? AND left_reason IS NULL", power);
    this.sql.exec(
      "INSERT INTO stints (power, stint, player_id, name, joined_at, substitute) VALUES (?, ?, ?, ?, ?, ?)",
      power,
      stint,
      player?.id ?? null,
      name,
      Date.now(),
      substitute ? 1 : 0,
    );
    return stint;
  }

  /**
   * The number the next stint at a seat takes. Numbers only ever grow, even past stints a deleted
   * account took away, because the index keys its rows on them: a reused number would collide with
   * the row the index still holds and the new holder's own row would never be written.
   */
  private nextStint(power: PowerName): number {
    const max = this.sql.exec<{ n: number | null }>("SELECT MAX(stint) AS n FROM stints WHERE power = ?", power).one().n;
    const floor = this.kv.get<Partial<Record<PowerName, number>>>("stint-floor")?.[power] ?? 0;
    return Math.max(max === null ? 0 : max + 1, floor);
  }

  /** Tell the index a signed-in player took a seat, so it shows on their games list. Best effort. */
  private noteSeat(power: PowerName, player: Signed | null, name: string, substitute: boolean): void {
    const index = gameIndex(this.env);
    if (!player || !index || !this.meta) return;
    const stint = this.sql.exec<{ n: number | null }>("SELECT MAX(stint) AS n FROM stints WHERE power = ?", power).one().n ?? 0;
    const claim = { gameId: this.meta.id, power, stint, playerId: player.id, name, joinedAt: Date.now(), substitute };
    this.ctx.waitUntil(index.recordSeat(claim).catch((error) => this.log("seat_note_failed", { error: String(error) }, "error")));
  }

  /** The creator starts early; open seats become AI seats when `aiFill` is on. */
  private async start(request: Request): Promise<Response> {
    if (!this.meta) return bad("no such game", 404);
    const auth = this.authorise(bearer(request));
    if (!auth || auth !== this.meta.creator) return bad("only the creator may start the game", 403);
    if (this.meta.status !== "lobby") return bad("game already started", 409);
    if (!this.meta.settings.aiFill && this.seats().some((s) => s.kind === "open")) {
      return bad("seats are still open", 409);
    }
    // A game that wants Claude asks for its place under the deployment's budget before it begins.
    await this.admitClaude();
    if (this.meta.status !== "lobby") return bad("game already started", 409);
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
    // Table talk from the lobby stays readable, but its read markers and limits end with the lobby.
    this.startPhase();
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    this.broadcastState();
    this.log("game_started", { humans: this.activeHumans().length });
    const phase = this.game!.phase();
    for (const seat of this.awayPlayers()) this.notices.push(notices.started(meta.id, seat.player_id!, seat.power, phase));
  }

  // ---------- push notices ----------

  /**
   * Signed-in players at a seat who are away from the game (no socket open for it): the only ones
   * a push is for. Someone with the game open sees what happened already.
   */
  private awayPlayers(options: { survivingOnly?: boolean } = {}): SeatRow[] {
    if (!pushEnabled(this.env)) return [];
    return this.seats().filter(
      (seat) =>
        seat.player_id !== null &&
        (seat.kind === "human" || seat.kind === "civil_disorder") &&
        !(options.survivingOnly && seat.eliminated === 1) &&
        this.socketsOf(seat.power).length === 0,
    );
  }

  /** The deadline is near: tell each away player who can act and has handed in nothing. Runs inside the caller's transaction. */
  private remind(): void {
    const meta = this.meta!;
    const game = this.game!;
    const phase = game.phase();
    meta.remindedPhase = phase;
    const now = Date.now();
    if (meta.deadlineAt === null || now >= meta.deadlineAt) return;
    const late = this.awayPlayers({ survivingOnly: true }).filter((seat) => {
      if (seat.ready === 1 || !canAct(game, seat.power)) return false;
      const stored = this.storedOrders(phase, seat.power);
      return !(stored?.source === "human" && stored.orders.length > 0);
    });
    for (const seat of late) this.notices.push(notices.deadline(meta.id, seat.player_id!, seat.power, phase, meta.deadlineAt, now));
    this.log("deadline_reminder", { reminded: late.map((s) => s.power), deadlineAt: meta.deadlineAt });
  }

  private summary(): GameSummary {
    const meta = this.meta!;
    return {
      id: meta.id,
      settings: meta.settings,
      status: meta.status,
      phase: this.game!.phase(),
      host: meta.creator,
      deadlineAt: meta.deadlineAt,
      serverTime: Date.now(),
      createdAt: meta.createdAt,
      seats: this.seatViews(),
      finished: meta.finished,
      pauseReason: meta.pauseReason,
      pausedUntil: meta.pause?.until ?? null,
      pausedRemainingMs: meta.pause?.remainingMs ?? null,
      history: this.history(),
      ai: this.aiSummary(),
    };
  }

  /** Every resolved phase with the supply-centre count it left each power, oldest first. */
  private history(): PhaseSummary[] {
    const rows = this.sql
      .exec<{ name: string; adjudicated_at: number; summary_json: string | null; results_json: string | null }>(
        `SELECT name, adjudicated_at, summary_json, results_json FROM (
           SELECT seq, name, adjudicated_at, summary_json, CASE WHEN summary_json IS NULL THEN results_json END AS results_json
           FROM phases ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq`,
        LIMITS.historyPhases,
      )
      .toArray();
    return rows.map((row) => {
      try {
        if (row.summary_json) return JSON.parse(row.summary_json) as PhaseSummary;
        // Phases resolved before summaries were stored: read the centres out of the full outcome.
        const next = (JSON.parse(row.results_json ?? "{}") as { next?: { centers?: Record<string, string[]> } }).next;
        return { phase: row.name, adjudicatedAt: row.adjudicated_at, centers: centreCounts(next?.centers ?? {}) };
      } catch {
        return { phase: row.name, adjudicatedAt: row.adjudicated_at, centers: centreCounts({}) };
      }
    });
  }

  /** Who is playing the AI seats and what it has cost so far. Public: there is nothing secret in a bill. */
  private aiSummary() {
    const meta = this.meta!;
    const brain = this.brain();
    return {
      brain: brain.deliberates && !meta.claudeOff ? ("claude" as const) : ("bot" as const),
      model: brain.deliberates ? CLAUDE_MODEL : null,
      claudeTurns: meta.claudeTurns,
      claudeCalls: meta.claudeCalls,
      spentUsd: meta.claudeSpentMicros / 1_000_000,
      capUsd: this.claudeCapMicros() / 1_000_000,
      tokens: meta.claudeTokens,
      stopped: meta.claudeOff,
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

  /**
   * Resolved pledges the viewer may read, oldest first, each with the nonce that opens it. Pledges
   * made to everyone are public once resolved; a private pledge is shown to the two powers it
   * concerns; when the game is over the whole ledger is open, so anyone can audit it.
   */
  private ledgerEntries(viewer: PowerName | null): LedgerEntry[] {
    const over = this.meta!.status === "finished" || this.meta!.status === "abandoned";
    return this.sql
      .exec<{ id: string; pledger: string; audience: string; phase: string; sealed: number; commitment: string; nonce: string; orders_json: string; receipt: string }>(
        "SELECT * FROM pledges WHERE receipt IS NOT NULL ORDER BY rowid",
      )
      .toArray()
      .filter((row) => over || row.audience === "ALL" || (viewer !== null && (row.pledger === viewer || row.audience === viewer)))
      .map((row) => ({
        id: row.id,
        pledger: row.pledger as PowerName,
        audience: row.audience as PowerName | "ALL",
        phase: row.phase,
        sealed: row.sealed === 1,
        commitment: row.commitment,
        nonce: row.nonce,
        orders: this.parseOrderList(row.orders_json),
        receipt: row.receipt as LedgerEntry["receipt"],
      }));
  }

  /**
   * The MILA saved game, plus a `cabal` key MILA tools ignore: pledges, receipts and phase
   * summaries. The engine's own record under that key (its version, the full rulebook, the
   * outcome, rejected orders) is kept and the room's summary is laid over it, so the file still
   * says which rules it was played under and replays under them anywhere.
   */
  private replay(viewer: PowerName | null): Record<string, unknown> {
    const meta = this.meta!;
    const saved = JSON.parse(this.game!.toSaved(meta.id)) as Record<string, unknown>;
    const own = typeof saved.cabal === "object" && saved.cabal !== null ? (saved.cabal as Record<string, unknown>) : {};
    saved.cabal = {
      ...own,
      ...({
        protocol: PROTOCOL_VERSION,
        status: meta.status,
        finished: meta.finished,
        pledges: this.ledgerEntries(viewer),
        history: this.history(),
      } satisfies ReplayExtension),
    };
    return saved;
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

  /** True when the seat has something to order in the current position. Cached per position. */
  private actable(power: PowerName): boolean {
    const game = this.game!;
    const phase = game.phase();
    if (this.actCache?.game !== game || this.actCache.phase !== phase) this.actCache = { game, phase, by: new Map() };
    let can = this.actCache.by.get(power);
    if (can === undefined) {
      try {
        can = canAct(game, power);
      } catch {
        can = false;
      }
      this.actCache.by.set(power, can);
    }
    return can;
  }

  /**
   * What everybody may know about each seat: who holds it, who is playing it, whether they are
   * connected and whether their orders are in. Never the orders themselves.
   * @param gone a socket that is closing and must not count as presence.
   */
  private seatViews(gone?: WebSocket): SeatView[] {
    const meta = this.meta;
    const running = !!meta && !!this.game && (meta.status === "active" || meta.status === "paused");
    const submitted = new Set(
      running ? this.sql.exec<{ power: string }>("SELECT power FROM orders WHERE phase = ?", this.game!.phase()).toArray().map((r) => r.power) : [],
    );
    const present = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === gone || ws.readyState !== WebSocket.OPEN) continue;
      const power = (ws.deserializeAttachment() as Attachment | null)?.power;
      if (power) present.add(power);
    }
    const aiBrain = meta ? this.aiSummary().brain : "bot";
    return this.seats().map((s) => {
      const autopilot = this.autopilot(s);
      return {
        power: s.power,
        kind: s.kind,
        name: s.name,
        ready: s.ready === 1,
        eliminated: s.eliminated === 1,
        missed: s.missed,
        autopilot,
        brain: s.kind === "ai" ? aiBrain : autopilot ? "bot" : null,
        handle: s.player_id !== null ? s.name : null,
        present: s.kind === "ai" || present.has(s.power),
        submitted: submitted.has(s.power),
        canAct: running && s.eliminated === 0 && s.kind !== "open" && this.actable(s.power),
        host: s.power === meta?.creator,
      };
    });
  }

  /** Tell the table who is connected. Presence is not part of the game, so it is not stored for `sync`. */
  private announcePresence(gone?: WebSocket): void {
    this.pending.push({ payload: JSON.stringify({ t: "seats", p: { seats: this.seatViews(gone) } } satisfies ServerMessage), audience: "ALL" });
  }

  private authorise(token: string): PowerName | null {
    const parsed = parseToken(token);
    if (!parsed || !this.meta || parsed.gameId !== this.meta.id) return null;
    const seat = this.seat(parsed.power as PowerName);
    if (!seat?.token_hash) return null;
    const hash = hashToken(token);
    if (sameHash(hash, seat.token_hash)) return seat.power;
    // A token issued to the seat's signed-in player for another device.
    const extra = this.sql.exec<{ power: string }>("SELECT power FROM seat_tokens WHERE token_hash = ?", hash).toArray()[0];
    return extra?.power === seat.power ? seat.power : null;
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
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment | null), power: null } satisfies Attachment);
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
    // Every socket starts unbound, a seat holder's included, so a full house must never refuse the
    // next arrival: that would let idle anonymous sockets lock the players out. The oldest unbound
    // socket makes way instead. A player's socket binds with its first frame and then holds no
    // spectator place, so nothing an anonymous caller opens can ever cost a player their seat.
    const unbound = this.socketsOf(null)
      .map((ws) => ({ ws, at: (ws.deserializeAttachment() as Attachment | null)?.at ?? 0 }))
      .sort((a, b) => a.at - b.at);
    const evict = unbound.length >= LIMITS.spectators ? unbound[0] : undefined;
    if (evict) {
      this.send(evict.ws, { t: "error", p: { code: "spectator_evicted", message: "this connection made way for a newer one; reconnect to keep watching" } });
      try {
        evict.ws.close(4408, "made way for a newer connection");
      } catch {
        // already closed
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ power: null, at: Date.now() } satisfies Attachment);
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
    const arrived = this.socketsOf(power).length === 0;
    ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment | null), power } satisfies Attachment);
    this.presenceChanged();
    this.send(ws, { t: "welcome", id, p: this.welcome(power) });
    if (arrived) this.announcePresence();
  }

  private welcome(power: PowerName | null): Extract<ServerMessage, { t: "welcome" }>["p"] {
    const meta = this.meta!;
    const game = this.game!;
    const phase = game.phase();
    const orders = power ? (this.storedOrders(phase, power)?.orders ?? []) : [];
    const press = this.pressPage(power, { limit: LIMITS.welcomePress });
    return {
      protocol: PROTOCOL_VERSION,
      gameId: meta.id,
      settings: meta.settings,
      status: meta.status,
      pauseReason: meta.pauseReason,
      pausedUntil: meta.pause?.until ?? null,
      pausedRemainingMs: meta.pause?.remainingMs ?? null,
      power,
      host: meta.creator,
      phase,
      state: game.state() as StateView,
      seats: this.seatViews(),
      deadlineAt: meta.deadlineAt,
      serverTime: Date.now(),
      seq: this.lastSeq(),
      orders,
      defaults: power ? this.defaultOrders(power) : [],
      press: press.press,
      pressMore: press.more,
      unread: power ? this.unread(power) : {},
      votes: this.votesView(power),
      history: this.history(),
      finished: meta.finished,
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

  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // Each frame is its own unit of work in the logs.
    return this.traced(requestIdFrom(null, "ws"), async () => {
      try {
        await this.onFrame(ws, raw);
      } finally {
        if (this.meta) this.settle();
      }
    });
  }

  private async onFrame(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // The limiter comes first, so no frame of any size or kind is ever free.
    if (!this.allow(ws)) {
      // Unparsed, but a client matching replies to requests still gets its `id` back.
      return this.send(ws, { t: "error", id: peekId(raw), p: { code: "rate_limited", message: "slow down" } });
    }
    // A string's UTF-8 size is at least its length, so the cheap test catches every large frame.
    if (typeof raw !== "string" || raw.length > LIMITS.frameBytes || new TextEncoder().encode(raw).byteLength > LIMITS.frameBytes) {
      this.send(ws, { t: "error", p: { code: "too_large", message: "frames are JSON text of at most 16 KB" } });
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
    if (!msg) {
      const sent = (data as { id?: unknown } | null)?.id;
      return this.send(ws, { t: "error", id: typeof sent === "string" ? sent.slice(0, 64) : undefined, p: { code: "bad_frame", message: "frame did not validate" } });
    }
    const id = "id" in msg ? msg.id : undefined;
    if (!this.meta || !this.game) return;
    if (msg.t === "hello") {
      // A welcome is the dearest reply the room gives: state, press, history.
      if (!this.allow(ws, LIMITS.helloCost - 1)) {
        return this.send(ws, { t: "error", id, p: { code: "rate_limited", message: "slow down" } });
      }
      return this.hello(ws, id, msg.p.token);
    }
    const { power } = (ws.deserializeAttachment() as Attachment | null) ?? { power: null };
    if (msg.t === "sync") {
      if (!this.allow(ws, LIMITS.syncCost - 1)) {
        return this.send(ws, { t: "error", id, p: { code: "rate_limited", message: "slow down" } });
      }
      return this.sync(ws, id, msg.p.since, power);
    }
    // Everything below changes the game, and only a seat may do that.
    if (!power) return this.send(ws, { t: "error", id, p: { code: "spectator", message: "spectators cannot act" } });
    // Reading is not playing: a thread can be marked read whatever the game is doing.
    if (msg.t === "press.read") return this.markRead(power, msg.p.with, msg.p.upTo);
    const status = this.meta.status;
    // A returning player may hand in orders while a live game is paused: that is what un-pauses it.
    // Before the game starts the seated players may talk at the table, and nothing else.
    const allowed = status === "active" || (status === "paused" && msg.t === "orders.set") || (status === "lobby" && msg.t === "press.send");
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
        if (this.meta.status !== "active" && this.meta.status !== "lobby") {
          return this.send(ws, { t: "error", id, p: { code: "not_active", message: "the game is not active" } });
        }
        // The seat may have changed hands meanwhile: a displaced player gets no last word.
        if (((ws.deserializeAttachment() as Attachment | null)?.power ?? null) !== power) {
          return this.send(ws, { t: "error", id, p: { code: "spectator", message: "spectators cannot act" } });
        }
        const error = this.press(power, msg.p.to, msg.p.body, msg.p.pledge, { ws, id }, msg.p.quote);
        if (error) this.send(ws, { t: "error", id, p: error });
        return;
      }
      case "vote":
        return this.vote(ws, id, power, msg.p.value, msg.p.include);
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    return this.traced(requestIdFrom(null, "ws"), async () => this.onSocketClose(ws, code, reason));
  }

  private onSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      // 1005 and 1006 are reserved: they describe a close and may not be sent in one.
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    this.socketGone(ws);
  }

  override webSocketError(ws: WebSocket): Promise<void> {
    return this.traced(requestIdFrom(null, "ws"), async () => this.socketGone(ws));
  }

  private socketGone(ws: WebSocket): void {
    if (!this.meta) return;
    // A spectator leaving is never an event in the game.
    const { power } = (ws.deserializeAttachment() as Attachment | null) ?? { power: null };
    if (power) {
      this.presenceChanged(ws);
      if (this.socketsOf(power, ws).length === 0) this.announcePresence(ws);
    }
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
        this.touchListing();
        this.broadcast({ t: "status", p: { status: "paused", reason: "humans_absent", until: meta.pause.until } }, "ALL");
        this.broadcast({ t: "deadline", p: { serverTime: Date.now(), phase: this.game!.phase(), deadlineAt: null } }, "ALL");
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
    this.touchListing();
    this.broadcast({ t: "status", p: { status: "active", reason: null } }, "ALL");
    this.broadcast({ t: "deadline", p: { serverTime: Date.now(), phase: this.game!.phase(), deadlineAt: meta.deadlineAt } }, "ALL");
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
   *
   * Every broadcast frame gets the next number in the room's sequence, and carries it as `seq` on
   * its envelope: a client that remembers the highest `seq` it has applied can ask for exactly the
   * frames after it. A frame that also reports its own number inside its payload is passed as a
   * function of that number.
   *
   * The store is bounded at every insert, not only when a phase resolves, because a phase can stay
   * open for days: frames numbered `eventsKept` behind the newest are dropped, and a `seats` or
   * `votes` frame, which is a whole snapshot, replaces the stored one before it for the same
   * audience. Replaying only the newest snapshot leaves a client exactly where replaying all of
   * them would.
   */
  private broadcast(message: ServerMessage | ((seq: number) => ServerMessage), audience: PowerName | "ALL"): number {
    const seq = this.lastSeq() + 1;
    const frame = typeof message === "function" ? message(seq) : message;
    const snapshot = frame.t === "seats" || frame.t === "votes" ? frame.t : null;
    if (snapshot) this.sql.exec("DELETE FROM events WHERE snapshot = ? AND audience = ?", snapshot, audience);
    const payload = JSON.stringify(frame);
    this.storeEvent(seq, audience, payload, snapshot);
    this.pending.push({ payload: withSeq(payload, seq), audience });
    return seq;
  }

  /** Write one numbered frame and drop whatever has fallen out of the window `sync` can replay. */
  private storeEvent(seq: number, audience: PowerName | "ALL", payload: string, snapshot: string | null = null): void {
    this.sql.exec("INSERT INTO events (seq, audience, payload_json, snapshot) VALUES (?, ?, ?, ?)", seq, audience, payload, snapshot);
    if (seq > LIMITS.eventsKept) this.sql.exec("DELETE FROM events WHERE seq <= ?", seq - LIMITS.eventsKept);
  }

  /** The number of the last broadcast frame; 0 before the first. Numbers only ever grow. */
  private lastSeq(): number {
    return this.sql.exec<{ n: number | null }>("SELECT MAX(seq) AS n FROM events").one().n ?? 0;
  }

  /**
   * Answer a `sync`: replay one page of the stored frames after `since` that this viewer may see,
   * each with its `seq`, then `synced` with the cursor for the next request.
   *
   * `gap` tells a client its cursor is no use: the frames after it have been pruned, or the cursor
   * is ahead of the room. Such a client asks for a fresh `welcome` instead.
   */
  private sync(ws: WebSocket, id: string | undefined, since: number, power: PowerName | null): void {
    const last = this.lastSeq();
    // Frames numbered `eventsKept` behind the newest are gone; a cursor older than that has a gap.
    if (since > last || since < last - LIMITS.eventsKept) {
      return this.send(ws, { t: "synced", id, p: { seq: last, more: false, gap: true } });
    }
    const events = this.sql
      .exec<{ seq: number; payload_json: string }>(
        "SELECT seq, payload_json FROM events WHERE seq > ? AND (audience = 'ALL' OR audience = ?) ORDER BY seq LIMIT ?",
        since,
        power ?? "ALL",
        LIMITS.syncPage,
      )
      .toArray();
    for (const ev of events) {
      try {
        ws.send(withSeq(this.asSeenBy(ev.payload_json, power), ev.seq));
      } catch {
        return; // socket already gone
      }
    }
    const more = events.length === LIMITS.syncPage;
    // With nothing left to replay the cursor is the room's, so frames the viewer may not see are skipped too.
    this.send(ws, { t: "synced", id, p: { seq: more ? events.at(-1)!.seq : last, more, gap: false } });
  }

  /**
   * A stored press frame holds the pledge as a stranger sees it. On replay the viewer gets the
   * pledge as it stands for them now: their own sealed orders, or the receipt that has since arrived.
   */
  private asSeenBy(payload: string, viewer: PowerName | null): string {
    if (!payload.startsWith('{"t":"press"') || payload.includes('"pledge":null')) return payload;
    try {
      const message = JSON.parse(payload) as Extract<ServerMessage, { t: "press" }>;
      if (!message.p.pledge) return payload;
      message.p.pledge = this.pledgeView(message.p.pledge.id, viewer);
      return JSON.stringify(message);
    } catch {
      return payload;
    }
  }

  private broadcastState(): void {
    if (!this.game || !this.meta) return;
    const game = this.game;
    const meta = this.meta;
    this.broadcast(
      (seq) => ({
        t: "state",
        p: {
          phase: game.phase(),
          state: game.state() as StateView,
          deadlineAt: meta.deadlineAt,
          serverTime: Date.now(),
          seq,
          status: meta.status,
        },
      }),
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

  private storedOrders(phase: string, power: PowerName): { orders: string[]; source: string; submittedAt: number } | undefined {
    const row = this.sql
      .exec<{ orders_json: string; source: string; submitted_at: number }>("SELECT orders_json, source, submitted_at FROM orders WHERE phase = ? AND power = ?", phase, power)
      .toArray()[0];
    return row ? { orders: this.parseOrderList(row.orders_json), source: row.source, submittedAt: row.submitted_at } : undefined;
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

  /**
   * Replace a seat's orders for the current phase. Every order is judged against the board, so
   * what is put on file is what the engine will adjudicate and the verdicts say why anything was
   * refused. Returns the verdicts, or an error when the seat or the phase is wrong.
   */
  private setOrders(
    power: PowerName,
    phase: string,
    orders: string[],
    source: "human" | "claude",
  ): { accepted: string[]; rejected: { text: string; reason: string }[]; verdicts: OrderVerdict[] } | { code: string; message: string } {
    const game = this.game!;
    const seat = this.seat(power);
    if (!seat || seat.eliminated === 1) return { code: "seat_inactive", message: "this seat cannot submit orders" };
    if (phase !== game.phase()) return { code: "stale_phase", message: `current phase is ${game.phase()}` };
    const kind = this.phaseKind();
    const { accepted, verdicts } = judgeOrders(game, power, kind, orders);
    const rejected = verdicts.filter((v) => !v.ok).map((v) => ({ text: v.text, reason: v.reason }));
    // A Claude turn with nothing usable leaves the bot's orders standing.
    if (source === "claude" && accepted.length === 0) return { accepted, rejected, verdicts };
    if (accepted.length === 0) {
      // Nothing to put on file. A player clearing a draft takes their own orders back, so sealed
      // defaults apply again as if nothing had been sent; the bot's cover for a seat in civil
      // disorder is never wiped by a submission that ordered nothing.
      const stored = this.storedOrders(phase, power);
      if (stored?.source === "human") {
        this.atomic(() => {
          this.sql.exec("DELETE FROM orders WHERE phase = ? AND power = ?", phase, power);
          this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
        });
      }
      return { accepted, rejected, verdicts };
    }
    let returned = false;
    this.atomic(() => {
      const first = this.storedOrders(phase, power) === undefined;
      this.writeOrders(phase, power, accepted, source);
      // The player is back: orders are what takes a seat out of civil disorder.
      if (source === "human" && seat.kind === "civil_disorder" && accepted.length > 0) {
        this.sql.exec("UPDATE seats SET kind = 'human', missed = 0, ready = 0 WHERE power = ?", power);
        this.sql.exec("DELETE FROM substitute_invites WHERE power = ?", power);
        returned = true;
      }
      // The table sees that orders are in (never what they are) the first time a seat files any.
      if (returned || first) this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    });
    if (returned) {
      this.log("seat_recovered", { power });
      this.touchListing();
      this.presenceChanged();
    }
    return { accepted, rejected, verdicts };
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
    this.send(ws, { t: "orders.default.ack", id, p: { accepted, rejected } });
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
    if (!this.spendChange(power)) return this.send(ws, { t: "error", id, p: TOO_MANY_CHANGES });
    this.atomic(() => {
      this.sql.exec("UPDATE seats SET ready = ? WHERE power = ?", ready ? 1 : 0, power);
      this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    });
    if (ready) {
      // The table has finished talking: Claude seats need not listen any longer.
      this.maybeBeginOrders();
      this.advance();
    }
  }

  /**
   * Count one change of mind (a ready flag, a ballot) against the seat's allowance for the phase.
   * Each one is a write and a frame to every socket, so a seat may not flip for ever. False when
   * the allowance is spent.
   */
  private spendChange(power: PowerName): boolean {
    const phase = this.game!.phase();
    const row = this.sql.exec<{ phase: string; n: number }>("SELECT phase, n FROM seat_changes WHERE power = ?", power).toArray()[0];
    const n = row && row.phase === phase ? row.n : 0;
    if (n >= LIMITS.changesPerPhase) return false;
    this.sql.exec(
      "INSERT INTO seat_changes (power, phase, n) VALUES (?, ?, ?) ON CONFLICT(power) DO UPDATE SET phase = excluded.phase, n = excluded.n",
      power,
      phase,
      n + 1,
    );
    return true;
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
    const asked = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM extension_requests WHERE phase = ? AND power = ?", phase, power).one().n > 0;
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
        this.broadcast({ t: "deadline", p: { serverTime: Date.now(), phase, deadlineAt: meta.deadlineAt } }, "ALL");
      }
      // A request already on record changes nothing, so it is acknowledged and not announced again.
      if (!asked || extended) this.broadcast({ t: "extend", p: { phase, requestedBy, needed, granted: extended, deadlineAt: meta.deadlineAt } }, "ALL");
    });
    if (extended) this.log("deadline_extended", { by: requestedBy, deadlineAt: meta.deadlineAt });
    this.send(ws, { t: "extend.ack", id, p: { phase, requests: requestedBy.length, extended } });
  }

  // ---------- press and pledges ----------

  /**
   * One page of the press a viewer may read, oldest first: public messages, and for a seat the
   * private ones it sent or received. `before` pages backwards by `sentAt`; `thread` narrows to the
   * public thread (`ALL`) or to the private thread with one power.
   */
  private pressPage(
    power: PowerName | null,
    options: { limit: number; phase?: string; before?: number; thread?: PowerName | "ALL" },
  ): { press: PressView[]; more: boolean } {
    const me = power ?? "";
    const phase = options.phase ?? null;
    const before = options.before ?? null;
    const thread = options.thread ?? null;
    const rows = this.sql
      .exec<{ id: string; phase: string; sender: string; recipient: string; body: string; sent_at: number; pledge_id: string | null; quote_id: string | null }>(
        `SELECT rowid AS rid, * FROM press
         WHERE (recipient = 'ALL' OR sender = ? OR recipient = ?)
           AND (? IS NULL OR phase = ?)
           AND (? IS NULL OR sent_at < ?)
           AND (? IS NULL OR (? = 'ALL' AND recipient = 'ALL') OR (? <> 'ALL' AND recipient <> 'ALL' AND (sender = ? OR recipient = ?)))
         ORDER BY sent_at DESC, rowid DESC LIMIT ?`,
        me,
        me,
        phase,
        phase,
        before,
        before,
        thread,
        thread,
        thread,
        thread,
        thread,
        options.limit + 1,
      )
      .toArray();
    const more = rows.length > options.limit;
    const press = rows
      .slice(0, options.limit)
      .reverse()
      .map((r) => ({
        id: r.id,
        phase: r.phase,
        from: r.sender as PowerName,
        to: r.recipient as PowerName | "ALL",
        body: r.body,
        sentAt: r.sent_at,
        pledge: r.pledge_id ? this.pledgeView(r.pledge_id, power) : null,
        quote: r.quote_id ? this.quoteView(r.quote_id) : null,
      }));
    return { press, more };
  }

  private pressFor(power: PowerName | null, phase?: string): PressView[] {
    return this.pressPage(power, { limit: LIMITS.welcomePress, ...(phase ? { phase } : {}) }).press;
  }

  /** `GET /press?before=&with=&limit=`: history beyond what a welcome carries. A seat token widens it to private threads. */
  private pressHistoryPage(request: Request): Response {
    const params = new URL(request.url).searchParams;
    const viewer = this.authorise(bearer(request));
    const thread = params.get("with");
    if (thread !== null && thread !== "ALL" && !(POWERS as readonly string[]).includes(thread)) return bad("with must be a power or ALL");
    if (thread !== null && thread !== "ALL" && !viewer) return bad("a private thread needs the seat token of one of its two powers", 401);
    const before = Number(params.get("before") ?? "");
    const limit = Number(params.get("limit") ?? LIMITS.pressPage);
    const page = this.pressPage(viewer, {
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(LIMITS.pressPageMax, Math.floor(limit))) : LIMITS.pressPage,
      ...(Number.isFinite(before) && before > 0 ? { before } : {}),
      ...(thread !== null ? { thread: thread as PowerName | "ALL" } : {}),
    });
    return json({ gameId: this.meta!.id, ...page });
  }

  /** Unread messages per thread for a seat: everything others sent it after the thread's read marker. */
  private unread(power: PowerName): Record<string, number> {
    const rows = this.sql
      .exec<{ thread: string; n: number }>(
        `SELECT t.thread AS thread, COUNT(*) AS n FROM (
           SELECT CASE WHEN recipient = 'ALL' THEN 'ALL' ELSE sender END AS thread, sent_at FROM press
           WHERE sender <> ? AND (recipient = 'ALL' OR recipient = ?)
         ) t LEFT JOIN press_reads r ON r.power = ? AND r.thread = t.thread
         WHERE t.sent_at > COALESCE(r.read_at, 0) GROUP BY t.thread`,
        power,
        power,
        power,
      )
      .toArray();
    return Object.fromEntries(rows.map((r) => [r.thread, r.n]));
  }

  /** Move a thread's read marker forward (never back) and tell every socket of the seat the new counts. */
  private markRead(power: PowerName, thread: PowerName | "ALL", upTo: number): void {
    this.sql.exec(
      "INSERT INTO press_reads (power, thread, read_at) VALUES (?, ?, ?) ON CONFLICT(power, thread) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)",
      power,
      thread,
      Math.min(upTo, Date.now() + 60_000),
    );
    // Not stored for `sync`: read markers are the viewer's own state and a welcome carries them.
    this.pending.push({ payload: JSON.stringify({ t: "press.unread", p: { unread: this.unread(power) } } satisfies ServerMessage), audience: power });
  }

  /**
   * The message a dispatch quotes, in its own words. Whoever can read the dispatch could already
   * read the quoted message: a quote is only ever taken from the same thread (see `press`).
   */
  private quoteView(id: string): PressQuote | null {
    const row = this.sql.exec<{ id: string; phase: string; sender: string; body: string }>("SELECT id, phase, sender, body FROM press WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    // Cut as a reader counts characters, by the same function the client previews a quote with.
    return { id: row.id, from: row.sender as PowerName, phase: row.phase, excerpt: excerpt(row.body, QUOTE_CHARS) };
  }

  private pledgeView(id: string, viewer: PowerName | null): PledgeView | null {
    const row = this.sql
      .exec<{ id: string; pledger: string; audience: string; phase: string; sealed: number; commitment: string; nonce: string; orders_json: string; receipt: string | null }>(
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
      // The nonce opens the commitment, so it is the pledger's secret until the receipt is issued.
      nonce: row.receipt !== null || viewer === row.pledger ? row.nonce : null,
    };
  }

  /** What `power` sent or received before `phase`, oldest first: the context a Claude seat reads. */
  private pressHistory(power: PowerName, phase: string, limit: number): AgentBrief["earlierPress"] {
    return this.sql
      .exec<{ phase: string; sender: string; recipient: string; body: string }>(
        `SELECT phase, sender, recipient, body FROM (
           SELECT rowid AS rid, phase, sender, recipient, body, sent_at FROM press
           WHERE phase <> ? AND (sender = ? OR recipient = ?) ORDER BY sent_at DESC, rowid DESC LIMIT ?
         ) ORDER BY sent_at, rid`,
        phase,
        power,
        power,
        limit,
      )
      .toArray()
      .map((r) => ({ phase: r.phase, from: r.sender, to: r.recipient, body: r.body }));
  }

  /** Store and deliver one press message. Fully synchronous; returns an error to show the sender, or null. */
  private press(
    from: PowerName,
    to: PowerName | "ALL",
    body: string,
    pledge: { orders: string[]; sealed: boolean; nonce?: string | undefined; commitment?: string | undefined } | undefined,
    origin?: { ws: WebSocket; id: string | undefined },
    quote?: string,
  ): { code: string; message: string } | null {
    const settings = this.meta!.settings;
    const kind = this.phaseKind();
    // Before the game starts there is one thread, the table, whatever press the game itself allows.
    const lobby = this.meta!.status === "lobby";
    if (lobby) {
      if (to !== "ALL") return { code: "lobby_public_only", message: "before the game starts, press goes to the whole table" };
      if (pledge) return { code: "bad_pledge", message: "there are no orders to pledge before the game starts" };
    } else {
      if (settings.rulebookPress && kind !== "M") {
        return { code: "press_closed", message: "rulebook press: no press during retreat and adjustment phases" };
      }
      if (settings.press === "gunboat") return { code: "no_press", message: "gunboat: no press" };
      if (settings.press === "public" && to !== "ALL") return { code: "public_only", message: "public press only" };
    }
    const phase = lobby ? "LOBBY" : this.game!.phase();
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
    // A quote comes from the thread the reply goes to: the table quotes the table, a private thread
    // only itself. Private words can never be carried to anyone who did not already read them.
    if (quote !== undefined) {
      const quoted = this.sql.exec<{ sender: string; recipient: string }>("SELECT sender, recipient FROM press WHERE id = ?", quote).toArray()[0];
      const sameThread =
        quoted !== undefined &&
        (to === "ALL"
          ? quoted.recipient === "ALL"
          : quoted.recipient !== "ALL" && ((quoted.sender === from && quoted.recipient === to) || (quoted.sender === to && quoted.recipient === from)));
      if (!sameThread) return { code: "bad_quote", message: "only a message from the same thread can be quoted" };
    }
    let canonical: string[] | null = null;
    let seal: { nonce: string; commitment: string } | null = null;
    if (pledge) {
      // A pledge is a promise about the pledger's own units, judged by the engine against the
      // board: an order for a unit the pledger does not have would be stamped kept without ever
      // being at risk. What comes back is the canonical text the receipt will be judged on.
      try {
        for (const o of pledge.orders) this.canonicalOwnOrder(o, kind, from);
        canonical = checkPledge(this.game!, from, pledge.orders);
      } catch (e) {
        return { code: "bad_pledge", message: e instanceof Error ? e.message : String(e) };
      }
      const nonce = pledge.nonce ?? randomNonce();
      seal = { nonce, commitment: pledgeCommit(canonical, nonce) };
      // A client that sealed the pledge itself must get back exactly the seal it made.
      if (pledge.commitment !== undefined && pledge.commitment !== seal.commitment) {
        return { code: "bad_pledge", message: "the commitment does not match these orders and nonce; commit to the canonical order text" };
      }
    }
    this.atomic(() => {
      let pledgeId: string | null = null;
      if (pledge && canonical && seal) {
        pledgeId = randomId(8);
        // Who made the promise and to whom, as they stood when it was made: the trust ledger follows people, not seats.
        this.sql.exec(
          "INSERT INTO pledges (id, pledger, audience, phase, sealed, commitment, nonce, orders_json, pledger_player, audience_player) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          pledgeId,
          from,
          to,
          phase,
          pledge.sealed ? 1 : 0,
          seal.commitment,
          seal.nonce,
          JSON.stringify(canonical),
          this.seat(from)?.player_id ?? null,
          to === "ALL" ? null : (this.seat(to)?.player_id ?? null),
        );
      }
      const pressId = randomId(8);
      // Strictly increasing, so `sentAt` orders a thread and pages it without ties.
      const latest = this.sql.exec<{ n: number | null }>("SELECT MAX(sent_at) AS n FROM press").one().n ?? 0;
      const sentAt = Math.max(Date.now(), latest + 1);
      this.sql.exec(
        "INSERT INTO press (id, phase, sender, recipient, body, sent_at, pledge_id, quote_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        pressId,
        phase,
        from,
        to,
        body,
        sentAt,
        pledgeId,
        quote ?? null,
      );
      const quoted = quote !== undefined ? this.quoteView(quote) : null;
      const view = (viewer: PowerName | null): PressView => ({
        id: pressId,
        phase,
        from,
        to,
        body,
        sentAt,
        pledge: pledgeId ? this.pledgeView(pledgeId, viewer) : null,
        quote: quoted,
      });
      if (to === "ALL") {
        // A sealed pledge reads differently for its pledger, so each socket gets its own view.
        const seq = this.lastSeq() + 1;
        this.storeEvent(seq, "ALL", JSON.stringify({ t: "press", p: view(null) }));
        for (const ws of this.ctx.getWebSockets()) {
          const viewer = (ws.deserializeAttachment() as Attachment | null)?.power ?? null;
          const message: ServerMessage = { t: "press", id: ws === origin?.ws ? origin.id : undefined, seq, p: view(viewer) };
          this.pending.push({ payload: JSON.stringify(message), audience: "ALL", only: ws });
        }
      } else {
        this.broadcast({ t: "press", p: view(to) }, to);
        if (to !== from) this.broadcast({ t: "press", id: origin?.id, p: view(from) }, from);
        // A private dispatch to someone away: tell them it came, never what it says. Once per
        // sender and phase: a rival cannot make a phone buzz sixty times a phase.
        const recipient = to !== from ? this.awayPlayers().find((seat) => seat.power === to) : undefined;
        if (recipient && this.sql.exec("INSERT OR IGNORE INTO press_notices (phase, recipient, sender) VALUES (?, ?, ?)", phase, to, from).rowsWritten > 0) {
          this.notices.push(notices.press(this.meta!.id, recipient.player_id!, from));
        }
      }
    });
    return null;
  }

  // ---------- draw votes ----------

  /** Surviving, present human players: the only seats whose agreement a draw needs. */
  private requiredVoters(): PowerName[] {
    return this.activeHumans().map((s) => s.power);
  }

  private ballots(): VotesView["draw"] {
    return this.sql
      .exec<{ power: PowerName; value: number; include_json: string | null }>("SELECT power, value, include_json FROM votes WHERE kind = 'draw' ORDER BY power")
      .toArray()
      .map((r) => ({ power: r.power, value: r.value === 1, include: r.include_json ? (JSON.parse(r.include_json) as PowerName[]) : null }));
  }

  /**
   * The draw vote as one viewer may see it. The tally is always public. Who voted is public when
   * the game says so (`publicVotes`); otherwise a viewer sees only their own ballot.
   */
  private votesView(viewer: PowerName | null, ballots = this.ballots()): VotesView {
    const required = this.requiredVoters();
    const hidden = !this.meta!.settings.publicVotes;
    const counted = ballots.filter((b) => required.includes(b.power));
    return {
      phase: this.game!.phase(),
      draw: hidden ? ballots.filter((b) => b.power === viewer) : ballots,
      required,
      hidden,
      cast: counted.length,
      yes: counted.filter((b) => b.value).length,
    };
  }

  /** Tell the table the vote has changed. When ballots are hidden, each voter is also sent their own. */
  private broadcastVotes(): void {
    const ballots = this.ballots();
    this.broadcast({ t: "votes", p: this.votesView(null, ballots) }, "ALL");
    if (this.meta!.settings.publicVotes) return;
    for (const ballot of ballots) this.broadcast({ t: "votes", p: this.votesView(ballot.power, ballots) }, ballot.power);
  }

  /**
   * A draw passes when every surviving, present human player has voted yes this phase. Seats
   * played by AI, seats in civil disorder and eliminated players are never required, so a ghost
   * can never veto. DIAS shares the draw among all survivors; without DIAS the voters must also
   * name the same set of sharers, and only that changes: it still takes everyone to agree.
   *
   * Nobody is cut out of a draw without agreeing to it. A power may be left out only if it is one
   * of the voters, who by voting for the proposal accept it: a survivor played by AI or in civil
   * disorder has no vote, so it always shares.
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
      const voters = new Set(this.requiredVoters());
      const voiceless = [...survivors].filter((p) => !voters.has(p) && !proposal!.includes(p));
      if (voiceless.length > 0) {
        return this.send(ws, {
          t: "error",
          id,
          p: { code: "bad_vote", message: `a draw can only leave out players who vote on it: ${voiceless.join(", ")} must be included` },
        });
      }
      if (proposal.length === survivors.size) proposal = null; // everyone: the same as naming nobody
    }
    const chosen = proposal ? JSON.stringify(proposal) : null;
    const before = this.sql.exec<{ value: number; include_json: string | null }>("SELECT value, include_json FROM votes WHERE power = ? AND kind = 'draw'", power).toArray()[0];
    if (before && before.value === (value ? 1 : 0) && before.include_json === chosen) return; // unchanged: no write, no broadcast
    if (!this.spendChange(power)) return this.send(ws, { t: "error", id, p: TOO_MANY_CHANGES });
    const game = this.game!;
    const snapshot = game.toSaved(meta.id);
    try {
      this.atomic(() => {
        this.sql.exec(
          "INSERT INTO votes (power, kind, value, include_json) VALUES (?, 'draw', ?, ?) ON CONFLICT(power, kind) DO UPDATE SET value = excluded.value, include_json = excluded.include_json",
          power,
          value ? 1 : 0,
          chosen,
        );
        this.broadcastVotes();
        const cast = this.ballots();
        const required = this.requiredVoters();
        if (required.length === 0) return;
        const ballots = required.map((p) => cast.find((v) => v.power === p));
        if (!ballots.every((b) => b?.value === true)) return;
        const proposals = new Set(ballots.map((b) => JSON.stringify(b!.include)));
        if (proposals.size !== 1) return; // everybody wants a draw, but not the same one
        const agreed = ballots[0]!.include;
        // Whoever has no vote now (a voter may have lapsed since the proposal was made) shares.
        const sharers = agreed ? [...survivors].filter((p) => agreed.includes(p) || !required.includes(p)) : [...survivors];
        game.declareDraw();
        this.conclude("draw", sharers, "vote");
      });
    } catch (error) {
      // Storage rolled back; the engine may already have been told the game is drawn. Put it back.
      this.game = restoreGame(Game, snapshot, meta.settings.rulebook);
      try {
        game.free();
      } catch {
        // already freed
      }
      this.log("vote_failed", { error: String(error) }, "error");
      this.send(ws, { t: "error", id, p: { code: "internal", message: "the vote could not be recorded; try again" } });
    }
  }

  // ---------- phases, deadlines and adjudication ----------

  private claudeBudget(): number {
    const configured = Number(this.env.CLAUDE_TURNS_PER_GAME);
    return Number.isFinite(configured) && configured >= 0 ? configured : LIMITS.claudeTurnsPerGame;
  }

  /** The game's spend cap in micro-dollars. */
  private claudeCapMicros(): number {
    const configured = Number(this.env.CLAUDE_USD_PER_GAME);
    const usd = this.env.CLAUDE_USD_PER_GAME !== undefined && Number.isFinite(configured) && configured >= 0 ? configured : LIMITS.claudeUsdPerGame;
    return Math.round(usd * 1_000_000);
  }

  /** The brain behind this game's AI seats. */
  private brain() {
    return seatBrain(this.meta!.settings, { hasKey: !!this.env.ANTHROPIC_API_KEY, hasQueue: !!this.env.AGENT_QUEUE });
  }

  /**
   * Ask the index, once, for this game's place under the deployment's Claude budget. A room caps
   * its own spend, but only the index can see every room: it admits a game while the day's budget
   * and the number of Claude games in play allow it. Asked before the game starts, so the first
   * phase already knows. Anything but a clear yes (a refusal, no index, an index that cannot be
   * reached) leaves the game to the bot: a spend control fails closed.
   */
  private async admitClaude(): Promise<void> {
    const asked = this.meta;
    if (!asked || asked.claudeAdmission !== null || this.admitting || !this.brain().deliberates) return;
    this.admitting = true;
    let verdict: { admitted: boolean; reason: string | null };
    try {
      const index = gameIndex(this.env);
      verdict = index
        ? await index.admitClaudeGame({ gameId: asked.id, capMicros: this.claudeCapMicros(), now: Date.now() })
        : { admitted: false, reason: "no_budget_authority" };
    } catch (error) {
      this.log("claude_admission_failed", { error: String(error) }, "error");
      verdict = { admitted: false, reason: "budget_unreachable" };
    } finally {
      this.admitting = false;
    }
    // The room may have moved on during the call: read it again.
    const meta = this.meta;
    if (!meta || meta.claudeAdmission !== null) return;
    this.atomic(() => {
      meta.claudeAdmission = verdict.admitted ? "admitted" : "refused";
      if (!verdict.admitted) meta.claudeOff ??= verdict.reason ?? "budget_refused";
    });
    this.log("claude_admission", { admitted: verdict.admitted, reason: verdict.reason });
  }

  /** Spent so far plus everything reserved for calls that have not reported: what the cap is held against. */
  private claudeCommittedMicros(): number {
    const reserved = this.sql.exec<{ n: number | null }>("SELECT SUM(reserved_micros) AS n FROM agent_calls WHERE cost_micros IS NULL").one().n ?? 0;
    return this.meta!.claudeSpentMicros + reserved;
  }

  /**
   * Reserve a Claude turn for one seat: one model call per step, each at its worst-case price.
   * Refused when the index has not admitted the game under the deployment's budget, when the game
   * has stopped asking, when the turn cap is spent, or when the reservation would take the game
   * past its spend cap. Because the reservation is never smaller than the bill (the brain refuses
   * a prompt larger than the reservation assumes, measured in bytes, which bound tokens), the cap
   * holds whatever the calls turn out to cost. Runs inside the caller's transaction.
   */
  private reserveTurn(phase: string, power: PowerName, steps: Step[]): boolean {
    const meta = this.meta!;
    // No place under the deployment's budget, no model call: the per-game cap alone bounds one game, not all of them.
    if (meta.claudeAdmission !== "admitted") return false;
    if (meta.claudeOff !== null || meta.claudeTurns >= this.claudeBudget()) return false;
    const kind = this.phaseKind();
    const wanted = steps.map((step) => ({ step, micros: reservationMicros(kind, step) }));
    const total = wanted.reduce((sum, w) => sum + w.micros, 0);
    if (this.claudeCommittedMicros() + total > this.claudeCapMicros()) {
      if (meta.claudeSpentMicros + reservationMicros("R", "order") > this.claudeCapMicros()) {
        // Not even the cheapest call fits any more: this game is done with Claude.
        meta.claudeOff = "spend_cap";
        this.log("claude_stopped", { why: "spend_cap", spentMicros: meta.claudeSpentMicros, capMicros: this.claudeCapMicros() });
      }
      return false;
    }
    for (const w of wanted) {
      this.sql.exec(
        "INSERT OR REPLACE INTO agent_calls (phase, power, step, reserved_micros) VALUES (?, ?, ?, ?)",
        phase,
        power,
        w.step,
        w.micros,
      );
    }
    meta.claudeTurns += 1;
    return true;
  }

  /** Put one step of the reserved turns on the queue (after the change commits). Runs inside the caller's transaction. */
  private dispatch(phase: string, powers: PowerName[], step: Step): void {
    const meta = this.meta!;
    const now = Date.now();
    for (const power of powers) {
      this.sql.exec("UPDATE agent_calls SET dispatched_at = ? WHERE phase = ? AND power = ? AND step = ?", now, phase, power, step);
      this.turns.push({ gameId: meta.id, power, phase, step });
    }
    meta.claudeCalls += powers.length;
  }

  /**
   * Tidy the call ledger as a phase opens. A reservation for a call that was never made is handed
   * back. A call that was handed to the consumer and never reported is charged its whole
   * reservation once it is certainly dead, because it may well have been billed. Runs inside the
   * caller's transaction.
   */
  private sweepCalls(phase: string, now: number): void {
    const meta = this.meta!;
    this.sql.exec("DELETE FROM agent_calls WHERE cost_micros IS NULL AND dispatched_at IS NULL AND phase <> ?", phase);
    // Queued for a phase that is over and never picked up: closed at no charge, so a late delivery
    // finds nothing to claim and no model call is ever made for it.
    this.sql.exec(
      "UPDATE agent_calls SET cost_micros = 0, outcome = 'undelivered' WHERE cost_micros IS NULL AND claimed_at IS NULL AND phase <> ?",
      phase,
    );
    const lost = this.sql
      .exec<CallRow>("SELECT * FROM agent_calls WHERE cost_micros IS NULL AND dispatched_at IS NOT NULL AND dispatched_at < ?", now - AGENT_CALL_TTL_MS)
      .toArray();
    for (const call of lost) {
      meta.claudeSpentMicros += call.reserved_micros;
      this.sql.exec(
        "UPDATE agent_calls SET cost_micros = reserved_micros, outcome = 'unreported' WHERE phase = ? AND power = ? AND step = ?",
        call.phase,
        call.power,
        call.step,
      );
      this.log("agent_call_unreported", { call: `${call.phase}:${call.power}:${call.step}`, chargedMicros: call.reserved_micros }, "error");
    }
    this.sql.exec(
      "DELETE FROM agent_calls WHERE cost_micros IS NOT NULL AND rowid <= (SELECT MAX(rowid) FROM agent_calls) - ?",
      LIMITS.agentCallsKept,
    );
  }

  /**
   * Open the current phase: set its clock and let every AI-played seat move.
   *
   * The in-room brain's orders go on file at once for every such seat, so no AI seat can ever
   * leave a phase without orders. If the game's brain also deliberates (Claude), each AI seat that
   * the budget can cover is then asked for better ones and stays un-ready until it answers or
   * times out. A movement phase with press and enough time opens with a round of negotiation;
   * every other phase goes straight to orders. Runs inside the caller's transaction.
   */
  private startPhase(): void {
    const meta = this.meta!;
    const game = this.game!;
    const phase = game.phase();
    const now = Date.now();
    const phaseMs = phaseSeconds(phase, meta.settings) * 1000;
    meta.deadlineAt = now + phaseMs;
    meta.retry = null;
    meta.aiDueAt = null;
    meta.ai = null;
    meta.pausedMsThisPhase = 0;
    this.sql.exec("UPDATE seats SET ready = 0");
    this.sweepCalls(phase, now);
    const brain = this.brain();
    // Nobody to play against, nobody to pay for: a game no human is playing is left to the bot.
    const deliberate = brain.deliberates && this.activeHumans().length > 0;
    const talks = this.phaseKind() === "M" && meta.settings.press !== "gunboat" && phaseMs >= NEGOTIATE_MIN_PHASE_MS;
    const asked: PowerName[] = [];
    for (const seat of this.seats()) {
      if (seat.eliminated === 1 || !(seat.kind === "ai" || this.autopilot(seat)) || !canAct(game, seat.power)) continue;
      this.writeOrders(phase, seat.power, brain.orders(game, seat.power, meta.id), "bot");
      if (deliberate && seat.kind === "ai" && this.reserveTurn(phase, seat.power, talks ? ["negotiate", "order"] : ["order"])) {
        asked.push(seat.power);
      } else {
        this.sql.exec("UPDATE seats SET ready = 1 WHERE power = ?", seat.power);
      }
    }
    if (asked.length > 0) {
      if (talks) {
        meta.ai = { step: "negotiate", listenUntil: now + listenMs(phaseMs) };
        meta.aiDueAt = Math.min(now + NEGOTIATE_LIMIT_MS, meta.deadlineAt);
        this.dispatch(phase, asked, "negotiate");
      } else {
        meta.ai = { step: "order", listenUntil: now };
        meta.aiDueAt = Math.min(now + AI_TURN_LIMIT_MS, meta.deadlineAt);
        this.dispatch(phase, asked, "order");
      }
    }
    this.broadcast({ t: "deadline", p: { serverTime: Date.now(), phase, deadlineAt: meta.deadlineAt } }, "ALL");
    this.touchListing();
  }

  /** Put Claude turns on the queue. If the queue is down the orders on file simply stand. */
  private async dispatchTurns(turns: AgentTurn[]): Promise<void> {
    try {
      await this.env.AGENT_QUEUE!.sendBatch(turns.map((body) => ({ body })));
    } catch (error) {
      this.log("agent_queue_failed", { error: String(error), turns: turns.length }, "error");
      // Nothing was delivered, so nothing can be billed: hand the reservations back.
      for (const turn of turns) {
        this.sql.exec(
          "DELETE FROM agent_calls WHERE phase = ? AND power = ? AND step = ? AND cost_micros IS NULL AND claimed_at IS NULL",
          turn.phase,
          turn.power,
          turn.step,
        );
      }
      if (this.game?.phase() === turns[0]?.phase) {
        this.releaseAiSeats("queue_failed");
        this.settle();
      }
    }
  }

  /** The room has waited long enough for the current step. */
  private aiTimeout(): void {
    const ai = this.meta!.ai;
    if (ai && ai.step !== "order") this.beginOrderStep(ai.step === "negotiate" ? "talks_timed_out" : "listened");
    else this.releaseAiSeats("timeout");
  }

  /**
   * Move from talking to ordering once every Claude seat has had its say and either the listening
   * time is up or every human who can act is ready (the table has stopped talking). Until then the
   * alarm is left pointing at whichever comes first.
   */
  private maybeBeginOrders(): void {
    const meta = this.meta!;
    const ai = meta.ai;
    if (!ai || ai.step === "order" || (meta.status !== "active" && meta.status !== "paused")) return;
    const phase = this.game!.phase();
    const talking = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_calls WHERE phase = ? AND step = 'negotiate' AND dispatched_at IS NOT NULL AND cost_micros IS NULL", phase)
      .one().n;
    if (talking > 0) return;
    // A game that has stopped asking Claude has nobody left to listen for.
    if (meta.claudeOff !== null) return this.beginOrderStep("claude_stopped");
    const humans = this.activeHumans().filter((seat) => canAct(this.game!, seat.power));
    const tableReady = this.activeHumans().length > 0 && humans.every((seat) => seat.ready === 1);
    const now = Date.now();
    if (now >= ai.listenUntil || tableReady) return this.beginOrderStep(tableReady ? "table_ready" : "listened");
    if (ai.step === "negotiate") {
      this.atomic(() => {
        meta.ai = { step: "listen", listenUntil: ai.listenUntil };
        meta.aiDueAt = Math.min(ai.listenUntil, meta.deadlineAt ?? ai.listenUntil);
      });
    }
  }

  /** Ask every Claude seat that is still in the phase for its final orders. */
  private beginOrderStep(why: string): void {
    const meta = this.meta!;
    const game = this.game!;
    if (meta.status !== "active" && meta.status !== "paused") return;
    const phase = game.phase();
    const now = Date.now();
    const asked: PowerName[] = [];
    this.atomic(() => {
      // Talks that never reported are over; whatever they cost is settled when they report or expire.
      const waiting = this.seats().filter((s) => s.kind === "ai" && s.eliminated === 0 && s.ready === 0 && canAct(game, s.power));
      for (const seat of waiting) {
        const reserved = this.sql
          .exec<CallRow>("SELECT * FROM agent_calls WHERE phase = ? AND power = ? AND step = 'order' AND dispatched_at IS NULL", phase, seat.power)
          .toArray()[0];
        if (reserved && meta.claudeOff === null) asked.push(seat.power);
        else this.sql.exec("UPDATE seats SET ready = 1 WHERE power = ?", seat.power);
      }
      if (asked.length > 0) {
        meta.ai = { step: "order", listenUntil: now };
        meta.aiDueAt = Math.min(now + AI_TURN_LIMIT_MS, meta.deadlineAt ?? Number.MAX_SAFE_INTEGER);
        this.dispatch(phase, asked, "order");
      } else {
        meta.ai = null;
        meta.aiDueAt = null;
      }
      // An order step that was reserved and will not be asked for costs nothing: hand it back.
      this.sql.exec("DELETE FROM agent_calls WHERE phase = ? AND dispatched_at IS NULL AND cost_micros IS NULL", phase);
      if (waiting.length !== asked.length) this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    });
    this.log("agent_orders_requested", { why, powers: asked });
    this.advance();
  }

  /** Stop waiting for Claude: every AI seat is ready with the orders it already has on file. */
  private releaseAiSeats(why: string): void {
    const meta = this.meta!;
    if (meta.status !== "active" && meta.status !== "paused") return;
    const waiting = this.seats().filter((s) => s.kind === "ai" && s.eliminated === 0 && s.ready === 0 && canAct(this.game!, s.power));
    this.atomic(() => {
      meta.aiDueAt = null;
      meta.ai = null;
      // Steps that were reserved and will now never be asked for cost nothing: hand them back.
      this.sql.exec("DELETE FROM agent_calls WHERE phase = ? AND dispatched_at IS NULL AND cost_micros IS NULL", this.game!.phase());
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
          meta.graceFrom = Date.now();
          meta.deadlineAt = Date.now() + meta.settings.graceSeconds * 1000;
          this.broadcast({ t: "deadline", p: { serverTime: Date.now(), phase, deadlineAt: meta.deadlineAt, grace: true } }, "ALL");
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
    return timedFirst("firstProcessMs", () => adjudicateStrict(game, { orders }, (e) => this.log("adjudicate_failed", { error: String(e) }, "error")));
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
    /** Of those, the ones whose orders came in only during the grace period. */
    const late = new Set<PowerName>();
    const graceFrom = meta.gracePhase === phase ? meta.graceFrom : null;
    /** Human seats that had something to order. */
    const expected = new Set<PowerName>();
    for (const seat of seats) {
      if (seat.eliminated === 1) continue;
      const stored = this.storedOrders(phase, seat.power);
      // Sealed defaults stand in for a present player's missing movement orders. A seat on
      // autopilot is covered by the bot, whose orders are already on file.
      // An empty row a player left behind counts as no row at all.
      const filed = stored && !(stored.source === "human" && stored.orders.length === 0) ? stored.orders : null;
      const text = filed ?? (kind === "M" && seat.kind !== "ai" ? this.defaultOrders(seat.power) : []);
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
        if (stored?.source === "human" && valid.length > 0) {
          moved.add(seat.power);
          if (graceFrom !== null && stored.submittedAt > graceFrom) late.add(seat.power);
        }
      }
    }
    const snapshot = game.toSaved(meta.id);
    try {
      this.atomic(() => {
        const outcome = holdEverything ? game.process({ orders: {} }) : this.resolvePhase(game, orders);
        this.applyOutcome(phase, kind, seats, orders, moved, expected, outcome, holdEverything, late);
      });
    } catch (error) {
      // `process` may have advanced the game before the throw. Put it back exactly as it was.
      this.game = restoreGame(Game, snapshot, meta.settings.rulebook);
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
    late: Set<PowerName> = new Set(),
  ): void {
    const meta = this.meta!;
    meta.retry = null;
    meta.aiDueAt = null;
    meta.ai = null;

    // Reliability, per holder: every phase a seat had something to order, whether its player did.
    for (const power of expected) {
      const onTime = moved.has(power) && !late.has(power) ? 1 : 0;
      this.sql.exec(
        "UPDATE stints SET due = due + 1, on_time = on_time + ?, late = late + ? WHERE power = ? AND left_reason IS NULL",
        onTime,
        late.has(power) ? 1 : 0,
        power,
      );
    }

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
    const summary: PhaseSummary = { phase, adjudicatedAt: Date.now(), centers: centreCounts(outcome.next.centers) };
    this.sql.exec(
      "INSERT INTO phases (name, results_json, adjudicated_at, summary_json) VALUES (?, ?, ?, ?)",
      phase,
      JSON.stringify(outcome),
      summary.adjudicatedAt,
      JSON.stringify(summary),
    );

    // Receipts for every pledge made in this phase.
    const pledges = this.sql
      .exec<{ id: string; pledger: string; audience: string; orders_json: string; nonce: string }>(
        "SELECT id, pledger, audience, orders_json, nonce FROM pledges WHERE phase = ? AND receipt IS NULL",
        phase,
      )
      .toArray();
    // Judged by the engine against the board the phase started from: silence while having units
    // to order breaks a pledge. A phase resolved by the hold-everything fallback binds nobody.
    const phaseIndex = this.game!.historyLength() - 1;
    for (const p of pledges) {
      const pledged = JSON.parse(p.orders_json) as string[];
      const receipt = heldEverything ? "void" : (this.game!.pledgeReceipt(phaseIndex, p.pledger, pledged, orders[p.pledger] ?? []) as Receipt);
      this.sql.exec("UPDATE pledges SET receipt = ? WHERE id = ?", receipt, p.id);
      // The receipt reveals the nonce, so the audience can open the commitment and check it themselves.
      const frame: ServerMessage = { t: "pledge.receipt", p: { pledgeId: p.id, receipt, revealed: pledged, nonce: p.nonce } };
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
    this.sql.exec("DELETE FROM seat_changes");

    this.broadcast(
      (seq) => ({
        t: "results",
        p: {
          phase,
          results: outcome.results as OrderResultView[],
          dislodged: outcome.dislodged,
          standoffs: outcome.standoffs,
          civil_disorder: outcome.civil_disorder,
          rejected: outcome.rejected ?? [],
          summary,
          seq,
        },
      }),
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
      const next = this.game!.phase();
      for (const seat of this.awayPlayers({ survivingOnly: true })) {
        if (canAct(this.game!, seat.power)) this.notices.push(notices.phase(meta.id, seat.player_id!, seat.power, phase, next, meta.deadlineAt, Date.now()));
      }
      this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
      if (hadVotes) this.broadcastVotes();
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
          ? drawScores(meta.settings.scoring, Object.fromEntries(POWERS.map((p) => [p, share.has(p) ? centers[p]! : 0])))
          : {};
    const now = Date.now();
    meta.status = result === "abandoned" ? "abandoned" : "finished";
    meta.deadlineAt = null;
    meta.pause = null;
    meta.pauseReason = null;
    meta.retry = null;
    meta.aiDueAt = null;
    meta.ai = null;
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
        players: this.playersRecord(),
        movementPhases: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM phases WHERE name LIKE '%M'").one().n,
      };
      // Whatever is still reserved may yet be billed, so it counts as spent when the place is handed back.
      const claude = meta.claudeAdmission === "admitted" ? { claude: { committedMicros: this.claudeCommittedMicros() } } : {};
      this.kv.put("registry-outbox", { record, attempts: 0, nextAt: now, ...claude } satisfies Outbox);
      this.outboxAt = now;
    }
    this.touchListing();
    this.broadcast({ t: "status", p: { status: meta.status, reason } }, "ALL");
    this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
    this.broadcast({ t: "finished", p: { result, winners, scores, reason } }, "ALL");
    this.broadcastState();
    this.log(result === "abandoned" ? "game_abandoned" : "game_finished", { result, reason, winners });
    // A lobby that never started has nothing to report.
    if (reason !== "lobby_expired" && reason !== "lobby_emptied") {
      const away = this.awayPlayers().map((seat) => seat.player_id!);
      if (away.length > 0) this.notices.push(notices.finished(meta.id, away, result, winners, reason));
    }
  }

  /**
   * Every stint at every seat, for the index: who held it, how reliably, and which of their
   * pledges count towards their trust ledger. AI seats are listed without a player. Seats from
   * before stints were kept get one stint with what the seat itself remembers.
   */
  private playersRecord(): GamePlayerRecord[] {
    const seats = this.seats();
    const stints = this.sql.exec<StintRow>("SELECT * FROM stints ORDER BY power, stint").toArray();
    const distinct = new Set(stints.map((s) => s.player_id).filter((id) => id !== null)).size;
    const pledges = this.sql
      .exec<{ pledger: string; audience: string; phase: string; receipt: Receipt; pledger_player: string | null; audience_player: string | null }>(
        "SELECT pledger, audience, phase, receipt, pledger_player, audience_player FROM pledges WHERE receipt IS NOT NULL",
      )
      .toArray();
    const out: GamePlayerRecord[] = [];
    for (const seat of seats) {
      if (seat.kind === "open") continue;
      const held = stints.filter((s) => s.power === seat.power);
      if (seat.kind === "ai" && held.length === 0) {
        out.push({
          power: seat.power, stint: 0, kind: "ai", playerId: null, name: seat.name, joinedAt: this.meta!.createdAt, substitute: false,
          leftReason: null, civilDisorder: false, phasesDue: 0, phasesOnTime: 0, phasesLate: 0, ledger: { kept: 0, broken: 0, void: 0 },
        });
        continue;
      }
      const rows: StintRow[] = held.length > 0
        ? held
        : [{ power: seat.power, stint: 0, player_id: seat.player_id, name: seat.name, joined_at: this.meta!.createdAt, substitute: 0, left_reason: null, due: 0, on_time: 0, late: 0 }];
      for (const row of rows) {
        const ledger =
          row.player_id === null
            ? { kept: 0, broken: 0, void: 0 }
            : ledgerTally(
                pledges
                  .filter((p) => p.pledger === seat.power && p.pledger_player === row.player_id)
                  .map((p) => ({ phase: p.phase, audience: p.audience, receipt: p.receipt, pledgerPlayer: p.pledger_player, audiencePlayer: p.audience_player })),
                distinct,
              );
        const current = row.left_reason === null;
        out.push({
          power: seat.power,
          stint: row.stint,
          kind: "human",
          playerId: row.player_id,
          name: row.name,
          joinedAt: row.joined_at,
          substitute: row.substitute === 1,
          leftReason: current ? null : "replaced",
          civilDisorder: current && seat.kind === "civil_disorder" && seat.eliminated === 0,
          phasesDue: row.due,
          phasesOnTime: row.on_time,
          phasesLate: row.late,
          ledger,
        });
      }
    }
    return out;
  }

  /**
   * Hand the final summary to the index. The entry stays in storage until the index has
   * confirmed it; failures back off exponentially to an hourly ceiling and then stop with a log
   * line. Called from the alarm, never from the path that broadcasts the result.
   */
  private async flushOutbox(): Promise<void> {
    if (this.flushingOutbox) return;
    const entry = this.kv.get<Outbox>("registry-outbox");
    const index = gameIndex(this.env);
    if (!entry || entry.gaveUp || !index) {
      this.outboxAt = null;
      return;
    }
    this.flushingOutbox = true;
    try {
      if (entry.claude) await index.releaseClaudeGame({ gameId: entry.record.gameId, spentMicros: entry.claude.committedMicros, now: Date.now() });
      await index.recordGame(entry.record);
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

  private call(phase: string, power: PowerName, step: Step): CallRow | undefined {
    return this.sql.exec<CallRow>("SELECT * FROM agent_calls WHERE phase = ? AND power = ? AND step = ?", phase, power, step).toArray()[0];
  }

  private agentMemory(power: PowerName): Memory {
    const row = this.sql.exec<{ memory_json: string }>("SELECT memory_json FROM agent_memory WHERE power = ?", power).toArray()[0];
    try {
      const value = row ? (JSON.parse(row.memory_json) as Partial<Memory>) : {};
      return { diary: Array.isArray(value.diary) ? value.diary : [], relationships: Array.isArray(value.relationships) ? value.relationships : [] };
    } catch {
      return { diary: [], relationships: [] };
    }
  }

  /** Store a seat's memory, bounded and reduced to plain strings and numbers whatever was sent. */
  private rememberAgent(power: PowerName, memory: Memory): void {
    const diary = (Array.isArray(memory.diary) ? memory.diary : [])
      .filter((entry): entry is string => typeof entry === "string")
      .slice(-MEMORY_LIMITS.diaryEntries)
      .map((entry) => entry.slice(0, MEMORY_LIMITS.diaryChars));
    const relationships = (Array.isArray(memory.relationships) ? memory.relationships : [])
      .filter((r) => r && typeof r.power === "string" && (POWERS as readonly string[]).includes(r.power) && r.power !== power)
      .slice(0, MEMORY_LIMITS.relationships)
      .map((r) => ({
        power: r.power,
        stance: Number.isFinite(Number(r.stance)) ? Math.max(-2, Math.min(2, Math.round(Number(r.stance)))) : 0,
        note: String(r.note ?? "").slice(0, MEMORY_LIMITS.noteChars),
      }));
    this.sql.exec(
      "INSERT INTO agent_memory (power, memory_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(power) DO UPDATE SET memory_json = excluded.memory_json, updated_at = excluded.updated_at",
      power,
      JSON.stringify({ diary, relationships } satisfies Memory),
      Date.now(),
    );
  }

  /**
   * Hand one step of a Claude turn to the consumer, or null when it is stale or no longer wanted.
   *
   * Asking is claiming: a step is handed out once. Queues deliver at least once, and a second
   * delivery of the same message must never become a second model call. A step that is refused
   * here was never sent to the model, so its reservation is released.
   */
  agentBrief(power: PowerName, phase: string, step: Step = "order", requestId?: string): AgentBrief | null {
    return this.traced(requestIdFrom(requestId, "q"), () => this.briefFor(power, phase, step));
  }

  private briefFor(power: PowerName, phase: string, step: Step): AgentBrief | null {
    const meta = this.meta;
    const game = this.game;
    if (!meta || !game) return null;
    try {
      const call = this.call(phase, power, step);
      // No reservation, already answered, or already handed to another delivery.
      if (!call || call.dispatched_at === null || call.cost_micros !== null || call.claimed_at !== null) return null;
      const seat = this.seat(power);
      const wanted =
        (meta.status === "active" || meta.status === "paused") &&
        game.phase() === phase &&
        !!seat &&
        seat.kind === "ai" &&
        seat.eliminated === 0 &&
        seat.ready === 0 &&
        meta.claudeOff === null &&
        meta.ai?.step === step;
      if (!wanted) {
        this.atomic(() => this.closeCall(call, 0, null, null, "stale"));
        // The last of the talks may just have closed without a word: do not keep the table waiting.
        if (step === "negotiate" && game.phase() === phase) this.maybeBeginOrders();
        return null;
      }
      this.sql.exec("UPDATE agent_calls SET claimed_at = ? WHERE phase = ? AND power = ? AND step = ?", Date.now(), phase, power, step);
      const ledger = this.ledger();
      return {
        gameId: meta.id,
        power,
        phase,
        step,
        state: game.state() as StateView,
        press: this.pressFor(power, phase).slice(-LIMITS.briefPress),
        earlierPress: this.pressHistory(power, phase, LIMITS.briefEarlierPress),
        trust: Object.fromEntries(Object.entries(ledger).map(([p, l]) => [p, { kept: l.kept, broken: l.broken }])),
        memory: this.agentMemory(power),
        deadlineAt: meta.deadlineAt,
      };
    } finally {
      this.settle();
    }
  }

  /** Record what a call cost and close it. Runs inside the caller's transaction. */
  private closeCall(call: CallRow, cost: number, model: string | null, usage: Usage | null, outcome: string): void {
    const meta = this.meta!;
    meta.claudeSpentMicros += cost;
    if (usage) {
      meta.claudeTokens = {
        inputTokens: meta.claudeTokens.inputTokens + usage.inputTokens,
        outputTokens: meta.claudeTokens.outputTokens + usage.outputTokens,
        cacheReadTokens: meta.claudeTokens.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: meta.claudeTokens.cacheWriteTokens + usage.cacheWriteTokens,
      };
    }
    this.sql.exec(
      "UPDATE agent_calls SET cost_micros = ?, model = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, outcome = ? WHERE phase = ? AND power = ? AND step = ?",
      cost,
      model,
      usage?.inputTokens ?? 0,
      usage?.outputTokens ?? 0,
      usage?.cacheReadTokens ?? 0,
      usage?.cacheWriteTokens ?? 0,
      outcome,
      call.phase,
      call.power,
      call.step,
    );
  }

  /**
   * Settle the bill for one call from what the API said it used. This happens whether or not the
   * answer is still wanted: a call that was paid for counts against the cap even when its phase
   * has moved on. A call whose cost is unknown is charged its whole reservation.
   */
  private settleCall(power: PowerName, phase: string, step: Step, report: AgentReport, outcome: string): void {
    const meta = this.meta!;
    const call = this.call(phase, power, step);
    // Each call is settled once; a duplicate report changes nothing.
    if (!call || call.cost_micros !== null) return;
    const usage = report.usage && report.billed !== "no" ? cleanUsage(report.usage) : null;
    const model = report.model ?? CLAUDE_MODEL;
    const cost = report.billed === "no" ? 0 : usage ? costMicros(model, usage) : call.reserved_micros;
    this.atomic(() => {
      this.closeCall(call, cost, report.model, usage, outcome);
      if (report.failure) {
        meta.claudeStrikes += 1;
        const status = report.failure.status;
        // A key the API rejects will be rejected for every seat in every phase: stop at once.
        const why = status === 401 || status === 403 ? "model_unauthorised" : meta.claudeStrikes >= LIMITS.claudeStrikes ? "model_failing" : null;
        if (why && meta.claudeOff === null) {
          meta.claudeOff = why;
          this.log("claude_stopped", { why, status, strikes: meta.claudeStrikes, error: report.failure.message.slice(0, 300) }, "error");
        }
      } else if (report.billed === "yes") {
        meta.claudeStrikes = 0;
      }
    });
    this.log("agent_call", {
      call: `${phase}:${power}:${step}`,
      outcome,
      model: report.model,
      costMicros: cost,
      ...usage,
      spentMicros: meta.claudeSpentMicros,
      capMicros: this.claudeCapMicros(),
    });
    if (meta.claudeSpentMicros > this.claudeCapMicros()) {
      // Cannot happen while reservations bound bills. If it ever does, say so loudly and stop.
      this.atomic(() => (meta.claudeOff ??= "spend_cap"));
      this.log("claude_cap_exceeded", { spentMicros: meta.claudeSpentMicros, capMicros: this.claudeCapMicros() }, "error");
    }
  }

  /**
   * Apply one step of a Claude seat's turn and settle what it cost.
   *
   * `decision` is null when the model produced nothing usable: the orders on file stand. Each part
   * of a decision is judged on its own and reported back, so a refused message or pledge never
   * costs the seat its orders. A step for a phase that has resolved is refused, never applied late.
   */
  agentSubmit(power: PowerName, phase: string, step: Step, decision: AgentDecision | null, report: AgentReport, requestId?: string): AgentOutcome {
    return this.traced(requestIdFrom(requestId, "q"), () => this.submitFor(power, phase, step, decision, report));
  }

  private submitFor(power: PowerName, phase: string, step: Step, decision: AgentDecision | null, report: AgentReport): AgentOutcome {
    const meta = this.meta;
    const game = this.game;
    const outcome: AgentOutcome = { applied: false, reason: "", orders: { accepted: [], rejected: [] }, messages: [], pledge: null };
    const refuse = (reason: string): AgentOutcome => ({ ...outcome, reason });
    if (!meta || !game) return refuse("no_such_game");
    try {
      const seat = this.seat(power);
      const reason = !(meta.status === "active" || meta.status === "paused")
        ? "not_active"
        : game.phase() !== phase
          ? "stale_phase"
          : !seat || seat.kind !== "ai" || seat.eliminated === 1
            ? "not_an_ai_seat"
            : seat.ready === 1
              ? "turn_already_closed"
              : step === "negotiate" && meta.ai?.step !== "negotiate"
                ? "talks_closed"
                : null;
      this.settleCall(power, phase, step, report, reason ?? (decision ? "answered" : report.failure ? "model_failed" : "no_decision"));
      if (reason !== null) return refuse(reason);

      if (decision) {
        if (step === "order") {
          const set = this.setOrders(power, phase, decision.orders.slice(0, 34), "claude");
          if ("accepted" in set) outcome.orders = set;
          outcome.applied = outcome.orders.accepted.length > 0;
        }
        if (meta.status === "active") {
          // In the talks the orders are a plan: a pledge may name any of the seat's legal orders.
          const pledgeable = step === "order" ? new Set(outcome.orders.accepted) : null;
          const pledgeTo = decision.pledge?.to.trim().toUpperCase() ?? null;
          for (const message of decision.messages.slice(0, LIMITS.agentMessages)) {
            const to = message.to.trim().toUpperCase();
            const body = message.body.trim().slice(0, LIMITS.agentBodyChars);
            if (!body || (to !== "ALL" && !(POWERS as readonly string[]).includes(to)) || to === power) {
              outcome.messages.push({ to: to.slice(0, 16), sent: false, code: "bad_message" });
              continue;
            }
            let pledge: { orders: string[]; sealed: boolean } | undefined;
            if (decision.pledge && pledgeTo === to && outcome.pledge === null) {
              const orders = decision.pledge.orders.slice(0, 34).filter((o) => pledgeable === null || pledgeable.has(o));
              if (orders.length > 0) pledge = { orders, sealed: decision.pledge.sealed === true };
              else outcome.pledge = "dropped";
            }
            let error = this.press(power, to as PowerName | "ALL", body, pledge);
            if (error?.code === "bad_pledge") {
              // The pledge was refused; the message itself is still worth sending.
              outcome.pledge = "dropped";
              pledge = undefined;
              error = this.press(power, to as PowerName | "ALL", body, undefined);
            }
            if (!error && pledge) outcome.pledge = "sent";
            outcome.messages.push({ to, sent: error === null, code: error?.code ?? null });
          }
          if (decision.pledge && outcome.pledge === null) outcome.pledge = "dropped";
        }
        if (report.memory) this.rememberAgent(power, report.memory);
      }

      if (step === "negotiate") {
        this.maybeBeginOrders();
        return { ...outcome, applied: outcome.messages.some((m) => m.sent), reason: decision ? "ok" : "said_nothing" };
      }
      this.atomic(() => {
        this.sql.exec("UPDATE seats SET ready = 1 WHERE power = ?", power);
        const waiting = this.seats().some((s) => s.kind === "ai" && s.eliminated === 0 && s.ready === 0 && canAct(game, s.power));
        if (!waiting) {
          meta.aiDueAt = null;
          meta.ai = null;
        }
        this.broadcast({ t: "seats", p: { seats: this.seatViews() } }, "ALL");
      });
      this.advance();
      return { ...outcome, reason: outcome.applied ? "ok" : "bot_orders_stand" };
    } finally {
      if (this.meta) this.settle();
    }
  }
}

/** Token counts from the consumer, reduced to non-negative whole numbers. */
function cleanUsage(usage: Usage): Usage {
  const n = (value: unknown) => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0);
  return {
    inputTokens: n(usage.inputTokens),
    outputTokens: n(usage.outputTokens),
    cacheReadTokens: n(usage.cacheReadTokens),
    cacheWriteTokens: n(usage.cacheWriteTokens),
  };
}

const TOO_MANY_CHANGES = { code: "too_many_changes", message: `at most ${LIMITS.changesPerPhase} changes of ready flag or ballot per phase` };

/** The `id` of a frame that will not be parsed, if it plainly has one. Never throws. */
function peekId(raw: string | ArrayBuffer): string | undefined {
  if (typeof raw !== "string" || raw.length > LIMITS.frameBytes) return undefined;
  return /"id"\s*:\s*"([^"\\]{1,64})"/.exec(raw)?.[1];
}

/** A stored frame with its sequence number on the envelope. Frames are JSON objects, so this is a splice. */
function withSeq(payload: string, seq: number): string {
  return `${payload.slice(0, -1)},"seq":${seq}}`;
}

/** Supply centres per power, every power present. */
function centreCounts(centers: Record<string, string[]>): Record<string, number> {
  return Object.fromEntries(POWERS.map((p) => [p, centers[p]?.length ?? 0]));
}

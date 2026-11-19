/**
 * @cabal/protocol/client: the one client for the wire protocol, shared by the web app, tools and
 * the server's own integration tests.
 *
 * `CabalSocket` owns a connection to one game:
 *
 *  - it binds the socket to a seat with a first `hello` frame (a seat token never goes in a URL);
 *  - it reconnects with exponential backoff and jitter, and gives up only when the server says the
 *    credential is no good;
 *  - it resumes: it remembers the `seq` of the last broadcast frame it delivered, asks the server
 *    for exactly the frames after it, and delivers every frame once and in order;
 *  - it keeps the connection alive with the text `ping` the server answers without waking the room,
 *    and treats a missing `pong` as a dead connection.
 *
 * It has no dependency on a browser or on Cloudflare: the caller supplies `connect`, a function
 * that returns a WebSocket (already open, or about to be). `createApi` is the matching typed
 * wrapper over the HTTP routes.
 */
import {
  type ClientMessage,
  type CreateGameRequest,
  CreateGameResponse,
  GameListing,
  GameRecord,
  GameSummary,
  HealthResponse,
  type JoinGameRequest,
  JoinGameResponse,
  LedgerResponse,
  type PledgeInput,
  type PowerName,
  PressPage,
  type Recipient,
  ServerMessage,
  SubstituteInviteResponse,
} from "./index.js";
import { z } from "zod";

// ---------- the socket ----------

/** The part of the WebSocket interface the client needs. Browsers, Node and workerd all provide it. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void): void;
}

export type Frame<T extends ServerMessage["t"] = ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;
export type Welcome = Frame<"welcome">["p"];

/**
 * `idle` before `start`; `connecting` while a socket opens and binds; `open` once a welcome has
 * been delivered; `waiting` between attempts; `closed` after `close()` or a fatal refusal.
 */
export type ConnectionStatus = "idle" | "connecting" | "open" | "waiting" | "closed";

/** Close codes after which reconnecting cannot help: the credential or the seat is gone. */
export const FATAL_CLOSE_CODES: readonly number[] = [4001, 4401, 4429];

/** An `error` frame from the server, or a local failure with the same shape. */
export class CabalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CabalError";
  }
}

export interface BackoffOptions {
  /** First delay. Default 500 ms. */
  minMs?: number;
  /** Ceiling. Default 30 s. */
  maxMs?: number;
  /** Growth per failed attempt. Default 2. */
  factor?: number;
  /** Share of each delay that is randomised away (0 to 1), so a room of clients does not return as one. Default 0.5. */
  jitter?: number;
}

/** The wait before reconnect attempt number `attempt` (0 is the first retry). */
export function backoffDelay(attempt: number, options: BackoffOptions = {}, random: () => number = Math.random): number {
  const { minMs = 500, maxMs = 30_000, factor = 2, jitter = 0.5 } = options;
  const ceiling = Math.min(maxMs, minMs * factor ** Math.max(0, attempt));
  return Math.round(ceiling * (1 - jitter * random()));
}

export interface CabalSocketOptions {
  /** Open a WebSocket to `/api/games/:id/ws`. Called once per attempt. */
  connect: () => SocketLike | Promise<SocketLike>;
  /** Seat token. Without one the socket is a spectator. */
  token?: string;
  backoff?: BackoffOptions;
  /** Interval between keepalive pings; 0 turns them off. Default 25 s. */
  heartbeatMs?: number;
  /** A ping not answered within this long means the connection is dead. Default 10 s. */
  pongTimeoutMs?: number;
  /** How long `request` waits for its reply. Default 15 s. */
  requestTimeoutMs?: number;
  /** Injectable clock, randomness and timers, for tests. */
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FrameMeta {
  /** True when the frame was missed while disconnected and is being replayed by a resume. */
  replayed: boolean;
}

type Listener<T> = (value: T, meta: FrameMeta) => void;

interface Pending {
  resolve: (frame: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

const OPEN = 1;

export class CabalSocket {
  /** The highest `seq` delivered to listeners: the resume cursor. */
  seq = 0;
  status: ConnectionStatus = "idle";
  /** The seat this socket is bound to, from the last welcome; null for a spectator. */
  power: PowerName | null = null;
  /** The last welcome delivered. */
  welcome: Welcome | null = null;
  /** Server clock minus local clock, in milliseconds, from the last frame that carried a server time. */
  clockOffsetMs = 0;
  /** Reconnect attempts since the last successful welcome. */
  attempt = 0;

  private ws: SocketLike | null = null;
  private generation = 0;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private listeners = new Map<string, Set<Listener<never>>>();
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  /** While a (re)connection is being brought up to date, live broadcast frames wait here. */
  private buffer: ServerMessage[] | null = null;
  private heldWelcome: Frame<"welcome"> | null = null;
  private syncId: string | null = null;
  private helloId: string | null = null;
  private welcomed = false;
  private firstWelcome: { resolve: (w: Welcome) => void; reject: (e: Error) => void }[] = [];

  constructor(private readonly options: CabalSocketOptions) {}

  // ----- lifecycle -----

  /** Begin connecting. Resolves with the first welcome (the seat's own when a token was given). */
  start(): Promise<Welcome> {
    const first = this.opened();
    if (this.status === "idle") void this.open();
    return first;
  }

  /** Resolves with the current welcome, or the next one if none has been delivered yet. */
  opened(): Promise<Welcome> {
    if (this.welcome && this.status === "open") return Promise.resolve(this.welcome);
    return new Promise((resolve, reject) => this.firstWelcome.push({ resolve, reject }));
  }

  /** Stop for good: no more reconnects. */
  close(code = 1000, reason = "bye"): void {
    this.finish(new CabalError("closed", "the connection was closed"));
    try {
      this.ws?.close(code, reason);
    } catch {
      // already closed
    }
    this.ws = null;
  }

  /**
   * Drop the current connection and reconnect after the first backoff delay, as if the network had
   * failed. For tests and for "the tab came back to the foreground" hooks.
   */
  reconnect(): void {
    if (this.status === "closed") return;
    const ws = this.ws;
    this.dropped();
    try {
      ws?.close(4000, "client reconnect");
    } catch {
      // already closed
    }
  }

  /** The server's clock, as best this client knows it. Use it for deadline countdowns. */
  serverNow(): number {
    return this.now() + this.clockOffsetMs;
  }

  // ----- listening -----

  /** Listen for one frame type, for every frame (`frame`), or for connection `status` changes. Returns the unsubscribe. */
  on<T extends ServerMessage["t"]>(type: T, listener: Listener<Frame<T>>): () => void;
  on(type: "frame", listener: Listener<ServerMessage>): () => void;
  on(type: "status", listener: Listener<ConnectionStatus>): () => void;
  on(type: "fatal", listener: Listener<CabalError>): () => void;
  on(type: string, listener: Listener<never>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit(type: string, value: unknown, meta: FrameMeta = { replayed: false }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      try {
        (listener as Listener<unknown>)(value, meta);
      } catch {
        // a listener's failure is its own; the connection carries on
      }
    }
  }

  // ----- sending -----

  /** Send a frame if the socket is open. Returns false when it is not. */
  send(frame: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a frame and wait for the frame that answers it (the server echoes the `id`). Rejects with
   * a `CabalError` when the answer is an `error` frame, on timeout, or when the connection drops.
   */
  request<T extends ServerMessage["t"] = ServerMessage["t"]>(frame: ClientMessage): Promise<Frame<T>> {
    const id = `c${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(id);
        reject(new CabalError("timeout", `no reply to ${frame.t}`));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve: resolve as (frame: ServerMessage) => void, reject, timer });
      if (!this.send({ ...frame, id } as ClientMessage)) {
        this.pending.delete(id);
        this.clearTimer(timer);
        reject(new CabalError("not_connected", "the socket is not open"));
      }
    });
  }

  /** Replace this seat's orders for a phase. The reply says, order by order, what the server made of them. */
  setOrders(phase: string, orders: string[]): Promise<Frame<"orders.ack">> {
    return this.request<"orders.ack">({ t: "orders.set", p: { phase, orders } });
  }

  setDefaults(orders: string[]): boolean {
    return this.send({ t: "orders.default", p: { orders } });
  }

  ready(phase: string, ready = true): boolean {
    return this.send({ t: "ready", p: { phase, ready } });
  }

  press(to: Recipient, body: string, pledge?: PledgeInput): Promise<Frame<"press">> {
    return this.request<"press">({ t: "press.send", p: { to, body, ...(pledge ? { pledge } : {}) } });
  }

  markRead(thread: Recipient, upTo: number): boolean {
    return this.send({ t: "press.read", p: { with: thread, upTo } });
  }

  vote(value: boolean, include?: PowerName[]): boolean {
    return this.send({ t: "vote", p: { kind: "draw", value, ...(include ? { include } : {}) } });
  }

  extend(phase: string): Promise<Frame<"extend.ack">> {
    return this.request<"extend.ack">({ t: "extend", p: { phase } });
  }

  // ----- connecting -----

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.options.setTimer ?? ((f: () => void, m: number) => setTimeout(f, m)))(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (handle === null || handle === undefined) return;
    (this.options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.setStatus("connecting");
    this.buffer = [];
    this.heldWelcome = null;
    this.syncId = null;
    this.helloId = null;
    this.welcomed = false;
    let ws: SocketLike;
    try {
      ws = await this.options.connect();
    } catch {
      if (generation === this.generation && this.status !== "closed") this.retry();
      return;
    }
    if (generation !== this.generation || this.status === "closed") {
      try {
        ws.close(1000, "superseded");
      } catch {
        // already closed
      }
      return;
    }
    this.ws = ws;
    const mine = () => generation === this.generation && this.ws === ws;
    ws.addEventListener("message", ((event: { data: unknown }) => {
      if (mine()) this.onMessage(event.data);
    }) as (event: never) => void);
    ws.addEventListener("close", ((event: { code?: number; reason?: string }) => {
      if (mine()) this.onClose(event.code ?? 1006, event.reason ?? "");
    }) as (event: never) => void);
    ws.addEventListener("error", (() => {
      if (mine() && ws.readyState !== OPEN) this.onClose(1006, "socket error");
    }) as (event: never) => void);
    const begin = () => {
      if (!mine()) return;
      if (this.options.token !== undefined) {
        this.helloId = `c${this.nextId++}`;
        this.send({ t: "hello", id: this.helloId, p: { token: this.options.token } });
      }
      this.startHeartbeat();
    };
    if (ws.readyState === OPEN) begin();
    else ws.addEventListener("open", begin as (event: never) => void);
  }

  private retry(): void {
    this.setStatus("waiting");
    const delay = backoffDelay(this.attempt++, this.options.backoff, this.options.random);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.status === "waiting") void this.open();
    }, delay);
  }

  /** The connection is gone (or is being abandoned): fail what was waiting on it and try again. */
  private dropped(): void {
    this.generation++;
    this.ws = null;
    this.stopHeartbeat();
    for (const [id, waiting] of this.pending) {
      this.clearTimer(waiting.timer);
      waiting.reject(new CabalError("disconnected", "the connection dropped before the server replied"));
      this.pending.delete(id);
    }
    if (this.status !== "closed") this.retry();
  }

  private onClose(code: number, reason: string): void {
    if (FATAL_CLOSE_CODES.includes(code)) {
      const error = new CabalError(code === 4401 ? "bad_token" : code === 4001 ? "seat_reassigned" : "too_many_sockets", reason || "the server refused this connection");
      this.finish(error);
      this.emit("fatal", error);
      return;
    }
    this.dropped();
  }

  private finish(error: CabalError): void {
    this.generation++;
    this.stopHeartbeat();
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    for (const [id, waiting] of this.pending) {
      this.clearTimer(waiting.timer);
      waiting.reject(error);
      this.pending.delete(id);
    }
    for (const waiter of this.firstWelcome.splice(0)) waiter.reject(error);
    this.setStatus("closed");
  }

  private startHeartbeat(): void {
    const every = this.options.heartbeatMs ?? 25_000;
    if (every <= 0) return;
    const beat = () => {
      const ws = this.ws;
      if (!ws || ws.readyState !== OPEN) return;
      try {
        ws.send("ping");
      } catch {
        return;
      }
      this.pongTimer = this.setTimer(() => {
        // No pong: the connection is dead even if nobody has told us so.
        try {
          ws.close(4000, "pong timeout");
        } catch {
          // already closed
        }
        if (this.ws === ws) this.dropped();
      }, this.options.pongTimeoutMs ?? 10_000);
      this.pingTimer = this.setTimer(beat, every);
    };
    this.pingTimer = this.setTimer(beat, every);
  }

  private stopHeartbeat(): void {
    this.clearTimer(this.pingTimer);
    this.clearTimer(this.pongTimer);
    this.pingTimer = this.pongTimer = null;
  }

  // ----- receiving -----

  private onMessage(data: unknown): void {
    if (data === "pong") {
      this.clearTimer(this.pongTimer);
      this.pongTimer = null;
      return;
    }
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(raw);
    // A frame this build does not know is skipped, so a newer server never breaks an older client.
    if (!parsed.success) return;
    const frame = parsed.data;

    if (frame.t === "welcome") return this.onWelcome(frame);
    if (frame.t === "synced" && frame.id !== undefined && frame.id === this.syncId) return this.onSynced(frame);
    if (frame.id !== undefined && frame.id === this.helloId && frame.t === "error") {
      // The hello was refused. The close that follows says whether that is final.
      return;
    }
    // The answer to a request is settled at once, whatever else is going on.
    this.settle(frame);
    if (this.buffer) {
      // Catching up: nothing is delivered until the replay and the snapshot can be put in order.
      this.buffer.push(frame);
      return;
    }
    this.deliver(frame, false);
  }

  private onWelcome(frame: Frame<"welcome">): void {
    // With a token, the spectator welcome every socket gets first is not ours to act on.
    if (this.options.token !== undefined && frame.p.power === null) return;
    if (this.welcomed) {
      // A fresh snapshot asked for mid-session: it is the truth as of its cursor.
      this.acceptWelcome(frame);
      return;
    }
    this.welcomed = true;
    if (this.seq > 0 && frame.p.seq > this.seq) {
      // We have been here before and missed something: replay it before the snapshot is delivered.
      this.heldWelcome = frame;
      this.syncId = `c${this.nextId++}`;
      this.send({ t: "sync", id: this.syncId, p: { since: this.seq } });
      return;
    }
    this.acceptWelcome(frame);
    this.flush();
  }

  private onSynced(frame: Frame<"synced">): void {
    const held = this.heldWelcome;
    if (!held) return;
    if (!frame.p.gap && frame.p.more && frame.p.seq < held.p.seq) {
      this.syncId = `c${this.nextId++}`;
      this.send({ t: "sync", id: this.syncId, p: { since: frame.p.seq } });
      return;
    }
    // Caught up. What was missed is delivered first, in order, each frame once; then the snapshot,
    // which is the truth as of its cursor. If the gap cannot be replayed the snapshot stands alone.
    this.syncId = null;
    this.heldWelcome = null;
    if (!frame.p.gap) {
      const missed = (this.buffer ?? []).filter((f) => f.seq !== undefined && f.seq <= held.p.seq).sort((a, b) => a.seq! - b.seq!);
      for (const f of missed) this.deliver(f, true);
    }
    this.acceptWelcome(held);
    this.flush();
  }

  private acceptWelcome(frame: Frame<"welcome">): void {
    this.welcome = frame.p;
    this.power = frame.p.power;
    this.seq = Math.max(this.seq, frame.p.seq);
    this.clockOffsetMs = frame.p.serverTime - this.now();
    this.attempt = 0;
    this.settle(frame);
    this.setStatus("open");
    this.emitFrame(frame, false);
    for (const waiter of this.firstWelcome.splice(0)) waiter.resolve(frame.p);
  }

  /**
   * Deliver what arrived while catching up and is newer than the snapshot: broadcast frames in
   * `seq` order, each once, then the frames that carry no number in the order they came.
   */
  private flush(): void {
    const waiting = this.buffer ?? [];
    this.buffer = null;
    for (const frame of waiting.filter((f) => f.seq !== undefined).sort((a, b) => a.seq! - b.seq!)) this.deliver(frame, false);
    for (const frame of waiting.filter((f) => f.seq === undefined)) this.deliver(frame, false);
  }

  private deliver(frame: ServerMessage, replayed: boolean): void {
    if (frame.seq !== undefined) {
      if (frame.seq <= this.seq) return; // already delivered
      this.seq = frame.seq;
    }
    this.emitFrame(frame, replayed);
  }

  private emitFrame(frame: ServerMessage, replayed: boolean): void {
    if (frame.t === "state" || frame.t === "deadline") this.clockOffsetMs = frame.p.serverTime - this.now();
    const meta = { replayed };
    this.emit(frame.t, frame, meta);
    this.emit("frame", frame, meta);
  }

  /** Resolve or reject the request this frame answers, if any. */
  private settle(frame: ServerMessage): void {
    if (frame.id === undefined) return;
    const waiting = this.pending.get(frame.id);
    if (!waiting) return;
    this.pending.delete(frame.id);
    this.clearTimer(waiting.timer);
    if (frame.t === "error") waiting.reject(new CabalError(frame.p.code, frame.p.message));
    else waiting.resolve(frame);
  }
}

// ---------- HTTP ----------

/** A non-2xx answer from the API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  /** Origin and prefix of the API, e.g. `` (same origin) or `https://cabal-server.example.workers.dev`. */
  baseUrl?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const ListingPage = z.object({ games: z.array(GameListing) });
const RecordPage = z.object({ games: z.array(GameRecord) });

/** Typed calls for every HTTP route. Seat tokens travel as bearer headers, never in a URL. */
export function createApi(options: ApiOptions = {}) {
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

  async function call<S extends z.ZodType>(schema: S, method: "GET" | "POST", path: string, opts: { token?: string; body?: unknown } = {}): Promise<z.infer<S>> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await doFetch(`${base}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // an empty or non-JSON body is reported by status alone
    }
    if (!res.ok) {
      const message = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
      throw new ApiError(res.status, message, body);
    }
    return schema.parse(body) as z.infer<S>;
  }

  const query = (params: Record<string, string | number | undefined>) => {
    const pairs = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
    return pairs.length === 0 ? "" : `?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}`;
  };

  return {
    health: () => call(HealthResponse, "GET", "/health"),
    createGame: (body: z.input<typeof CreateGameRequest>) => call(CreateGameResponse, "POST", "/api/games", { body }),
    joinGame: (gameId: string, body: JoinGameRequest) => call(JoinGameResponse, "POST", `/api/games/${gameId}/join`, { body }),
    startGame: (gameId: string, token: string) => call(GameSummary, "POST", `/api/games/${gameId}/start`, { token }),
    inviteSubstitute: (gameId: string, token: string, power: PowerName) =>
      call(SubstituteInviteResponse, "POST", `/api/games/${gameId}/substitute`, { token, body: { power } }),
    summary: (gameId: string) => call(GameSummary, "GET", `/api/games/${gameId}`),
    /** Public games waiting for players (`open`) or in play (`active`). */
    listLive: (status: "open" | "active", page: { limit?: number; before?: number } = {}) =>
      call(ListingPage, "GET", `/api/games${query({ status, ...page })}`).then((r) => r.games),
    /** Finished and abandoned games, most recent first. */
    listFinished: (page: { limit?: number; before?: number; result?: "solo" | "draw" | "abandoned" } = {}) =>
      call(RecordPage, "GET", `/api/games${query({ status: "finished", ...page })}`).then((r) => r.games),
    ledger: (gameId: string, token?: string) => call(LedgerResponse, "GET", `/api/games/${gameId}/ledger`, token ? { token } : {}),
    /** The MILA saved game; its `cabal` key holds pledges, receipts and phase summaries (`ReplayExtension`). */
    replay: (gameId: string, token?: string) => call(z.record(z.string(), z.unknown()), "GET", `/api/games/${gameId}/replay`, token ? { token } : {}),
    press: (gameId: string, page: { before?: number; with?: Recipient; limit?: number } = {}, token?: string) =>
      call(PressPage, "GET", `/api/games/${gameId}/press${query(page)}`, token ? { token } : {}),
  };
}

export type CabalApi = ReturnType<typeof createApi>;

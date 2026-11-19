/** Shared fixtures: every suite drives the real Worker and real Durable Objects inside workerd. */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { expect } from "vitest";
import type { GameRecord, GameSettings, ServerMessage } from "@cabal/protocol";
import { botOrders } from "../src/bot.js";
import { botRuntime } from "../src/brain.js";
import type { Env as ServerEnv } from "../src/env.js";
import { gameIndex } from "../src/game-index.js";
import type { GameRoom } from "../src/room.js";
import { peacefulOrders } from "./peaceful-bot.js";

export const serverEnv = env as unknown as ServerEnv;

// Suites are about the room unless they say otherwise: AI seats are played by a bot that never
// dislodges anything, so a test meets no retreat it did not arrange. See `realBots`.
botRuntime.orders = peacefulOrders;

/** Put the real bot (the Rust heuristic player) behind the AI seats for the rest of this file. */
export function realBots(): void {
  botRuntime.orders = botOrders;
}
export const POWERS = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"] as const;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let requestSequence = 0;
/** A fresh client address per request, so the per-address rate limits never couple tests. */
export const nextIp = () => `198.51.${Math.floor(++requestSequence / 250) % 250}.${(requestSequence % 250) + 1}`;

export interface Seat {
  gameId: string;
  token: string;
  power: string;
}

export interface Summary {
  id: string;
  status: string;
  phase: string;
  host: string;
  serverTime: number;
  createdAt: number;
  history: { phase: string; adjudicatedAt: number; centers: Record<string, number> }[];
  deadlineAt: number | null;
  pauseReason: string | null;
  pausedUntil: number | null;
  pausedRemainingMs: number | null;
  settings: GameSettings;
  seats: {
    power: string;
    kind: string;
    name: string | null;
    missed: number;
    ready: boolean;
    eliminated: boolean;
    autopilot: boolean;
    brain: "bot" | "claude" | null;
    present: boolean;
    submitted: boolean;
    canAct: boolean;
    host: boolean;
  }[];
  finished: { result: string; winners: string[]; scores: Record<string, number>; reason: string | null } | null;
  ai: {
    brain: "bot" | "claude";
    model: string | null;
    claudeTurns: number;
    claudeCalls: number;
    spentUsd: number;
    capUsd: number;
    tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    stopped: string | null;
  };
}

export async function create(name: string, settings: Record<string, unknown> = {}): Promise<Seat> {
  const res = await SELF.fetch("http://cabal/api/games", {
    method: "POST",
    headers: { "cf-connecting-ip": nextIp() },
    body: JSON.stringify({ name, settings }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Seat;
}

export function joinRaw(gameId: string, body: unknown, token?: string): Promise<Response> {
  return SELF.fetch(`http://cabal/api/games/${gameId}/join`, {
    method: "POST",
    headers: { "cf-connecting-ip": nextIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

export async function join(gameId: string, name: string, power?: string): Promise<Seat> {
  const res = await joinRaw(gameId, power ? { name, power } : { name });
  expect(res.status).toBe(200);
  return (await res.json()) as Seat;
}

export const start = (seat: Seat) =>
  SELF.fetch(`http://cabal/api/games/${seat.gameId}/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${seat.token}`, "cf-connecting-ip": nextIp() },
  });

export const inviteSubstitute = (seat: Seat, power: string) =>
  SELF.fetch(`http://cabal/api/games/${seat.gameId}/substitute`, {
    method: "POST",
    headers: { authorization: `Bearer ${seat.token}`, "cf-connecting-ip": nextIp() },
    body: JSON.stringify({ power }),
  });

export const summary = async (gameId: string) =>
  (await (await SELF.fetch(`http://cabal/api/games/${gameId}`, { headers: { "cf-connecting-ip": nextIp() } })).json()) as Summary;

/** A summary without what changes by itself: the server's clock and who happens to be connected. */
export const stable = (s: Summary) => ({ ...s, serverTime: 0, seats: s.seats.map((seat) => ({ ...seat, present: false })) });

export const stubOf = (gameId: string) => serverEnv.GAME_ROOM.get(serverEnv.GAME_ROOM.idFromName(gameId));

/** The room's private parts, for arranging situations that would take hours of real play. */
export interface RoomInternals {
  meta: {
    deadlineAt: number | null;
    status: string;
    retry: { attempts: number; at: number } | null;
    aiDueAt: number | null;
    pause: { remainingMs: number; since: number; until: number } | null;
    idlePhases: number;
    gracePhase: string | null;
    ai: { step: "negotiate" | "listen" | "order"; listenUntil: number } | null;
    claudeTurns: number;
    claudeCalls: number;
    claudeSpentMicros: number;
    claudeStrikes: number;
    claudeOff: string | null;
  };
  env: ServerEnv;
  armedAt: number | null;
  outboxAt: number | null;
  sql: { exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[]; one(): T } };
  kv: { get<T>(key: string): T | undefined; put(key: string, value: unknown): void };
  rearm(): void;
  settle(): void;
  advance(): void;
  adjudicate(holdEverything?: boolean): void;
  resolvePhase(game: unknown, orders: Record<string, string[]>): unknown;
  applyOutcome(...args: unknown[]): void;
  flushOutbox(): Promise<void>;
}

export function inRoom<T>(gameId: string, fn: (room: RoomInternals, state: DurableObjectState) => T | Promise<T>): Promise<T> {
  return runInDurableObject(stubOf(gameId), (instance: GameRoom, state) => fn(instance as unknown as RoomInternals, state));
}

/** Run a query against a room's SQLite database. */
export function sql<T = Record<string, unknown>>(gameId: string, query: string, ...bindings: unknown[]): Promise<T[]> {
  return inRoom(gameId, (room) => room.sql.exec<T>(query, ...bindings).toArray());
}

/**
 * Bring the phase deadline close and let the room's own alarm fire. Nothing calls `alarm()` here:
 * the deadline is moved, the alarm is re-armed from it, and the runtime wakes the room.
 */
export async function deadlineIn(gameId: string, ms = 60): Promise<void> {
  await inRoom(gameId, (room) => {
    room.meta.deadlineAt = Date.now() + ms;
    room.kv.put("meta", room.meta);
    room.rearm();
  });
}

/**
 * Deliver the room's pending alarm now, exactly as the runtime would at its due time (the alarm is
 * consumed). For timers too long to wait out in a test: retries, backoff and the lobby expiry.
 */
export const fireAlarm = (gameId: string) => runDurableObjectAlarm(stubOf(gameId));

/** Poll until `probe` returns something truthy. */
export async function until<T>(probe: () => Promise<T | false | null | undefined>, what: string, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

export const untilStatus = (gameId: string, want: string) =>
  until(async () => {
    const s = await summary(gameId);
    return s.status === want ? s : null;
  }, `status ${want}`);

export const untilPhase = (gameId: string, want: string | ((phase: string) => boolean)) =>
  until(async () => {
    const s = await summary(gameId);
    return (typeof want === "string" ? s.phase === want : want(s.phase)) ? s : null;
  }, `phase ${typeof want === "string" ? want : "predicate"}`);

export const registry = () => serverEnv.REGISTRY!.get(serverEnv.REGISTRY!.idFromName("global"));

/** The number of the newest file in migrations/: the schema version D1 reports. */
export const D1_SCHEMA = Number.parseInt((env as unknown as { TEST_MIGRATIONS: { name: string }[] }).TEST_MIGRATIONS.at(-1)!.name, 10);

/** The deployment's games index (D1 in tests, as in production). */
export const index = () => gameIndex(serverEnv)!;

export const untilIndexed = (gameId: string) =>
  until<GameRecord>(async () => index().getGame(gameId), `index record for ${gameId}`);

type Frame<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

export class Client {
  ws: WebSocket;
  frames: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  pongs = 0;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(ws: WebSocket, private seated: boolean) {
    this.ws = ws;
    ws.accept();
    ws.addEventListener("close", (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
    });
    ws.addEventListener("message", (ev) => {
      // The keepalive answer is the one thing on the wire that is not a JSON frame.
      if (ev.data === "pong") return void this.pongs++;
      const m = JSON.parse(ev.data as string) as ServerMessage;
      // A player's socket is welcomed as a spectator first; its own welcome follows the hello.
      if (this.seated && m.t === "welcome" && m.p.power === null) return;
      this.frames.push(m);
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w!.resolve(m);
      }
    });
  }

  /** Open a socket. With a token the first frame is `hello`: the token never goes in the URL. */
  static async connect(gameId: string, token?: string): Promise<Client> {
    const res = await SELF.fetch(`http://cabal/api/games/${gameId}/ws`, {
      headers: { upgrade: "websocket", "cf-connecting-ip": nextIp() },
    });
    expect(res.status).toBe(101);
    const client = new Client(res.webSocket!, token !== undefined);
    if (token !== undefined) client.send({ t: "hello", p: { token } });
    return client;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.ws.close(1000, "bye");
  }

  /** The next frame of a type (already received or still to come), optionally matching a predicate. */
  next<T extends ServerMessage["t"]>(t: T, match: (m: Frame<T>) => boolean = () => true, timeoutMs = 10_000): Promise<Frame<T>> {
    const pred = (m: ServerMessage) => m.t === t && match(m as Frame<T>);
    const existing = this.frames.find(pred);
    if (existing) {
      this.frames.splice(this.frames.indexOf(existing), 1);
      return Promise.resolve(existing as Frame<T>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          this.frames.splice(this.frames.indexOf(m), 1);
          resolve(m as Frame<T>);
        },
      });
    });
  }

  has(t: ServerMessage["t"]): boolean {
    return this.frames.some((m) => m.t === t);
  }

  clear(): void {
    this.frames = [];
  }

  untilClosed(): Promise<{ code: number; reason: string }> {
    return until(async () => this.closed, "socket close");
  }
}

/** Hold every unit and ready up for the current movement phase, then wait for the next movement phase. */
export async function holdAndReady(client: Client, units: string[], phase: string): Promise<Frame<"state">> {
  client.send({ t: "orders.set", p: { phase, orders: units.map((unit) => `${unit} H`) } });
  await client.next("orders.ack", (m) => m.p.phase === phase);
  client.send({ t: "ready", p: { phase, ready: true } });
  return client.next("state", (m) => m.p.phase !== phase && m.p.phase.endsWith("M"));
}

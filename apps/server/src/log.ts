/**
 * Structured logs: one JSON object per line, so Workers Logs can filter and group on any field.
 *
 * Every line names where it came from (`service`: the Worker, a room or the queue consumer) and
 * the request that caused it (`requestId`). The id is set once where work enters the system (an
 * HTTP request, a WebSocket frame, an alarm, a queue message) and carried by AsyncLocalStorage
 * through every await below it, so a line written deep inside a room needs no plumbing to say
 * which request it belongs to. The Worker hands its id to a room in the `x-request-id` header,
 * and to a room's RPC methods as an argument, so one id follows a request across the hop.
 *
 * Logs never carry secrets, seat tokens, player secrets, press bodies or client addresses, and a
 * thrown value's message and stack have their handles masked (handles.ts `maskHandles`).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { maskHandles } from "./handles.js";

export type Service = "worker" | "room" | "queue" | "registry";

export interface LogContext {
  service: Service;
  requestId: string;
  /** Fields every line in this context carries, such as a room's game id. */
  [field: string]: unknown;
}

const context = new AsyncLocalStorage<LogContext>();

/** The header a request id travels in from the Worker to a room. */
export const REQUEST_ID_HEADER = "x-request-id";

/** A request id is short and plain: anything else arriving in a header is replaced, never logged. */
const ID_SHAPE = /^[A-Za-z0-9:_-]{1,64}$/;

/** A fresh id, prefixed with what started the work (`req`, `ws`, `alarm`, `q`). */
export function newRequestId(prefix = "req"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The id to use for incoming work: `given` when it has the right shape, else a fresh one. */
export function requestIdFrom(given: string | null | undefined, prefix = "req"): string {
  return given && ID_SHAPE.test(given) ? given : newRequestId(prefix);
}

/** Run `fn` with every log line inside it, however deep, carrying `ctx`. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return context.run(ctx, fn);
}

/** The context of the work in progress, if any. */
export function currentLogContext(): LogContext | undefined {
  return context.getStore();
}

/** The current request id, for handing to the next hop. */
export function currentRequestId(): string | undefined {
  return context.getStore()?.requestId;
}

/**
 * Write one line. `fields` add to the context's fields and may refine them, but never replace
 * `ts`, `level`, `event`, `service` or `requestId`: filtering on those must always work.
 */
export function log(event: string, fields: Record<string, unknown> = {}, level: "info" | "error" = "info"): void {
  const ctx = context.getStore();
  const pinned = { ts: new Date().toISOString(), level, event, ...(ctx ? { service: ctx.service, requestId: ctx.requestId } : {}) };
  // `pinned` first for the order of the keys, last so nothing overrides it.
  const line = JSON.stringify({ ...pinned, ...ctx, ...fields, ...pinned });
  if (level === "error") console.error(line);
  else console.info(line);
}

/** What is safe and useful to log about a thrown value: handles it quotes are masked. */
export function describeError(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) {
    return { error: maskHandles(`${error.name}: ${error.message}`), ...(error.stack ? { stack: maskHandles(error.stack).slice(0, 2000) } : {}) };
  }
  return { error: maskHandles(String(error)) };
}

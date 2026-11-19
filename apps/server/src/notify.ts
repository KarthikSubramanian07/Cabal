/**
 * Notifications by Web Push: what a room tells a signed-in player who is away from the game.
 *
 * A room builds `Notice`s while it changes (inside its transaction, so a rolled back change tells
 * nobody anything) and hands them here once the change has committed. Delivery is best effort and
 * never holds a game up: one encrypted push per subscribed device that wants that kind of notice,
 * a subscription the push service calls gone (404, 410) is deleted, and one log line per notice
 * says how it went.
 *
 * Copy is the server's, in plain words. A notice never carries orders, press text or anything
 * sealed: it says what happened and links to the game.
 */
import type { NotificationKind, PowerName, PushPayload } from "@cabal/protocol";
import type { Env } from "./env.js";
import { describeError, log } from "./log.js";
import { type PushOptions, type VapidKeys, pushRequest } from "./push.js";
import { type Recipient, pushStore } from "./push-store.js";

export interface Notice {
  kind: NotificationKind;
  gameId: string;
  /** Signed-in players to tell; each of their devices that wants this kind gets one push. */
  playerIds: string[];
  title: string;
  body: string;
  /** Replaces an undelivered notice with the same topic, and a shown one with the same tag. */
  topic: string;
  urgency: PushOptions["urgency"];
  /** How long a push service may hold the notice for a device that is offline. */
  ttlSeconds: number;
}

/** The keys configured for this deployment: `VAPID_PUBLIC_KEY` (config) and `VAPID_PRIVATE_KEY` (secret). */
function configuredKeys(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "https://playcabal.pages.dev" };
}

/**
 * Seams for tests, like `botRuntime`: the suite turns push on with its own keys only where it
 * means to (every other suite runs with push off, as a deployment without the secret does), and
 * never reaches a real push service.
 */
export const pushRuntime: { fetch: (request: Request) => Promise<Response>; keys: (env: Env) => VapidKeys | null } = {
  fetch: (request) => fetch(request),
  keys: configuredKeys,
};

/** The deployment's VAPID keys, or null when push is not configured (then nothing is sent). */
export const vapidKeys = (env: Env): VapidKeys | null => pushRuntime.keys(env);

export const pushEnabled = (env: Env) => vapidKeys(env) !== null && env.DB !== undefined;

/** Minutes before a deadline the reminder goes out: `PUSH_REMINDER_MINUTES`, 5 to 1440, default 60. */
export function reminderMinutes(env: Env): number {
  const n = Number(env.PUSH_REMINDER_MINUTES ?? "60");
  return Number.isFinite(n) ? Math.min(1440, Math.max(5, Math.round(n))) : 60;
}

// ---------- copy ----------

const SEASONS: Record<string, string> = { S: "Spring", F: "Fall", W: "Winter" };
const KINDS: Record<string, string> = { M: "movement", R: "retreats", A: "adjustments" };

/** `S1901M` as "Spring 1901 movement". Anything else is returned as it is. */
export function phaseName(phase: string): string {
  const m = /^([SFW])(\d{4})([MRA])$/.exec(phase);
  return m ? `${SEASONS[m[1]!]} ${m[2]} ${KINDS[m[3]!]}` : phase;
}

/** `FRANCE` as "France". */
export const powerName = (power: string) => power.charAt(0) + power.slice(1).toLowerCase();

/** "45 minutes", "1 hour", "2 hours". */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

const DAY_S = 24 * 3600;

/** Why a game was abandoned, in a player's words, by the room's reason code. */
const ABANDONED_BECAUSE: Record<string, string> = {
  no_orders: "Nobody ordered for three movement phases.",
  adjudication_failed: "The server could not resolve a phase, so the game was stopped.",
};

export const notices = {
  started: (gameId: string, playerId: string, power: PowerName, phase: string): Notice => ({
    kind: "started",
    gameId,
    playerIds: [playerId],
    title: "The game has begun",
    body: `Game ${gameId}. You play ${powerName(power)}; ${phaseName(phase)} is open for orders.`,
    topic: `${gameId}-started`,
    urgency: "high",
    ttlSeconds: DAY_S,
  }),
  phase: (gameId: string, playerId: string, power: PowerName, resolved: string, next: string, deadlineAt: number | null, now: number): Notice => ({
    kind: "phase",
    gameId,
    playerIds: [playerId],
    title: `${phaseName(resolved)} is resolved`,
    body: `Game ${gameId}. ${phaseName(next)} is open: ${powerName(power)} has orders to write.`,
    topic: `${gameId}-phase`,
    urgency: "normal",
    ttlSeconds: deadlineAt === null ? DAY_S : Math.max(60, Math.floor((deadlineAt - now) / 1000)),
  }),
  deadline: (gameId: string, playerId: string, power: PowerName, phase: string, deadlineAt: number, now: number): Notice => {
    const minutes = Math.max(1, Math.round((deadlineAt - now) / 60_000));
    return {
      kind: "deadline",
      gameId,
      playerIds: [playerId],
      title: `Orders due in ${duration(minutes)}`,
      body: `Game ${gameId}, ${phaseName(phase)}. ${powerName(power)} has no orders in yet.`,
      topic: `${gameId}-deadline`,
      urgency: "high",
      // Worthless once the deadline has passed.
      ttlSeconds: Math.max(60, Math.floor((deadlineAt - now) / 1000)),
    };
  },
  press: (gameId: string, playerId: string, from: PowerName): Notice => ({
    kind: "press",
    gameId,
    playerIds: [playerId],
    title: `A private dispatch from ${powerName(from)}`,
    body: `Game ${gameId}. Open the game to read it.`,
    topic: `${gameId}-press-${from}`,
    urgency: "normal",
    ttlSeconds: DAY_S,
  }),
  finished: (gameId: string, playerIds: string[], result: "solo" | "draw" | "abandoned", winners: PowerName[], reason: string | null = null): Notice => ({
    kind: "finished",
    gameId,
    playerIds,
    title: result === "solo" && winners[0] ? `${powerName(winners[0])} takes Europe` : result === "draw" ? "The game ends in a draw" : "The game was abandoned",
    body: result === "abandoned" ? `Game ${gameId}. ${ABANDONED_BECAUSE[reason ?? ""] ?? "It ended without a result."}` : `Game ${gameId}. The final board and the ledger are in.`,
    topic: `${gameId}-finished`,
    urgency: "normal",
    ttlSeconds: 7 * DAY_S,
  }),
};

// ---------- delivery ----------

export interface DeliveryReport {
  devices: number;
  delivered: number;
  gone: number;
  failed: number;
}

async function sendOne(notice: Notice, target: Recipient, keys: VapidKeys, now: number): Promise<"delivered" | "gone" | "failed"> {
  const payload: PushPayload = {
    kind: notice.kind,
    gameId: notice.gameId,
    title: notice.title,
    body: notice.body,
    url: `/g/${notice.gameId}`,
    tag: notice.topic,
    sentAt: now,
  };
  try {
    const request = await pushRequest(target, payload, { ttl: notice.ttlSeconds, urgency: notice.urgency, topic: notice.topic }, keys, now);
    const res = await pushRuntime.fetch(request);
    // The body is never needed; release it.
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404 || res.status === 410) return "gone";
    if (res.status >= 200 && res.status < 300) return "delivered";
    log("push_rejected", { kind: notice.kind, gameId: notice.gameId, status: res.status, pushService: new URL(target.endpoint).hostname }, "error");
    return "failed";
  } catch (error) {
    log("push_failed", { kind: notice.kind, gameId: notice.gameId, pushService: new URL(target.endpoint).hostname, ...describeError(error) }, "error");
    return "failed";
  }
}

/** Deliver notices. Never throws; returns what happened, which is also logged. */
export async function deliver(env: Env, list: readonly Notice[], now = Date.now()): Promise<DeliveryReport> {
  const total: DeliveryReport = { devices: 0, delivered: 0, gone: 0, failed: 0 };
  const keys = vapidKeys(env);
  const store = pushStore(env);
  if (!keys || !store || list.length === 0) return total;
  for (const notice of list) {
    const report: DeliveryReport = { devices: 0, delivered: 0, gone: 0, failed: 0 };
    try {
      const targets = await store.recipients(notice.playerIds, notice.kind);
      report.devices = targets.length;
      const outcomes = await Promise.all(targets.map((t) => sendOne(notice, t, keys, now)));
      await Promise.all(
        outcomes.map((outcome, i) => {
          report[outcome] += 1;
          const endpoint = targets[i]!.endpoint;
          return (outcome === "gone" ? store.gone(endpoint) : outcome === "failed" ? store.failed(endpoint) : store.delivered(endpoint)).catch((error) =>
            log("push_bookkeeping_failed", describeError(error), "error"),
          );
        }),
      );
    } catch (error) {
      log("push_lookup_failed", { kind: notice.kind, gameId: notice.gameId, ...describeError(error) }, "error");
    }
    if (report.devices > 0) log("push_sent", { kind: notice.kind, gameId: notice.gameId, ...report });
    for (const k of ["devices", "delivered", "gone", "failed"] as const) total[k] += report[k];
  }
  return total;
}

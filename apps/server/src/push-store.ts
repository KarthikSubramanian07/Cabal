/**
 * Push subscriptions and notification preferences, in D1 (migration 0010).
 *
 * A subscription belongs to a player and to the device session that made it: signing that device
 * out deletes it by cascade, so a shared computer stops hearing about a player who left it. A
 * player keeps at most `DEVICES_PER_PLAYER` subscriptions; the oldest make way.
 */
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationKind, type NotificationPreferences, type PushSubscriptionRequest } from "@cabal/protocol";
import { fromBase64Url, p256Point, type PushTarget } from "./push.js";
import { hashToken } from "./tokens.js";

/** Browsers a player may have subscribed at once; every notice is one push per device. */
export const DEVICES_PER_PLAYER = 5;
/** Failed deliveries in a row (other than "gone") before a subscription is given up on. */
export const MAX_FAILURES = 20;

/**
 * Push services a subscription may point at. The server sends to whatever endpoint it is given, so
 * it must be a real push service and never an address of the subscriber's choosing.
 */
const PUSH_SERVICES = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Opera
  /^android\.googleapis\.com$/, // older Chrome subscriptions
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^(web|api)\.push\.apple\.com$/, // Safari
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows
];

export type SubscriptionProblem = "endpoint" | "keys";

/** Why a subscription cannot be stored, or null when it can. */
export function subscriptionProblem(sub: PushSubscriptionRequest): SubscriptionProblem | null {
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return "endpoint";
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return "endpoint";
  if (!PUSH_SERVICES.some((host) => host.test(url.hostname))) return "endpoint";
  if (!p256Point(sub.keys.p256dh)) return "keys";
  try {
    if (fromBase64Url(sub.keys.auth).byteLength !== 16) return "keys";
  } catch {
    return "keys";
  }
  return null;
}

const KINDS = ["deadline", "phase", "press", "started", "finished"] as const satisfies readonly NotificationKind[];

interface PreferenceRow {
  deadline: number;
  phase: number;
  press: number;
  started: number;
  finished: number;
}

export interface Recipient extends PushTarget {
  playerId: string;
}

export class PushStore {
  constructor(private readonly db: D1Database) {}

  /** Store (or move) one browser's subscription for the player signed in with `secret`. Returns their device count. */
  async subscribe(playerId: string, secret: string, sub: PushSubscriptionRequest, now: number): Promise<number> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO push_subscriptions (endpoint, player_id, session_hash, p256dh, auth, created_at, failures) VALUES (?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(endpoint) DO UPDATE SET player_id = excluded.player_id, session_hash = excluded.session_hash,
             p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at, failures = 0`,
        )
        .bind(sub.endpoint, playerId, hashToken(secret), sub.keys.p256dh, sub.keys.auth, now),
      // The oldest devices make way past the cap.
      this.db
        .prepare(
          `DELETE FROM push_subscriptions WHERE player_id = ? AND endpoint NOT IN (
             SELECT endpoint FROM push_subscriptions WHERE player_id = ? ORDER BY created_at DESC, endpoint LIMIT ?)`,
        )
        .bind(playerId, playerId, DEVICES_PER_PLAYER),
    ]);
    return this.devices(playerId);
  }

  /** Forget one of this player's subscriptions. True when there was one. */
  async unsubscribe(playerId: string, endpoint: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND player_id = ?").bind(endpoint, playerId).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async devices(playerId: string): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE player_id = ?").bind(playerId).first<{ n: number }>();
    return row?.n ?? 0;
  }

  async preferences(playerId: string): Promise<NotificationPreferences> {
    const row = await this.db.prepare("SELECT deadline, phase, press, started, finished FROM notification_preferences WHERE player_id = ?").bind(playerId).first<PreferenceRow>();
    if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    return Object.fromEntries(KINDS.map((k) => [k, row[k] === 1])) as NotificationPreferences;
  }

  async setPreferences(playerId: string, change: { [K in keyof NotificationPreferences]?: boolean | undefined }, now: number): Promise<NotificationPreferences> {
    const next = { ...(await this.preferences(playerId)) };
    for (const k of KINDS) if (typeof change[k] === "boolean") next[k] = change[k];
    await this.db
      .prepare(
        `INSERT INTO notification_preferences (player_id, deadline, phase, press, started, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET deadline = excluded.deadline, phase = excluded.phase, press = excluded.press,
           started = excluded.started, finished = excluded.finished, updated_at = excluded.updated_at`,
      )
      .bind(playerId, ...KINDS.map((k) => (next[k] ? 1 : 0)), now)
      .run();
    return next;
  }

  /** Every device of these players that wants this kind of notice. */
  async recipients(playerIds: readonly string[], kind: NotificationKind): Promise<Recipient[]> {
    if (playerIds.length === 0) return [];
    // `kind` is one of five fixed column names, checked here; it is never text from a request.
    if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`unknown notification kind ${kind}`);
    const ids = [...new Set(playerIds)].slice(0, 50);
    const rows = await this.db
      .prepare(
        `SELECT s.endpoint, s.p256dh, s.auth, s.player_id FROM push_subscriptions s
         LEFT JOIN notification_preferences p ON p.player_id = s.player_id
         WHERE s.player_id IN (${ids.map(() => "?").join(", ")}) AND COALESCE(p.${kind}, 1) = 1
         ORDER BY s.player_id, s.created_at DESC`,
      )
      .bind(...ids)
      .all<{ endpoint: string; p256dh: string; auth: string; player_id: string }>();
    return rows.results.map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, playerId: r.player_id }));
  }

  /** The push service says this subscription is gone (404 or 410): forget it. */
  async gone(endpoint: string): Promise<void> {
    await this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  }

  /** Count a failed delivery, and give the subscription up after too many in a row. */
  async failed(endpoint: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?").bind(endpoint),
      this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND failures >= ?").bind(endpoint, MAX_FAILURES),
    ]);
  }

  /** A delivery went through: the failure count starts again. Written only when it was not zero. */
  async delivered(endpoint: string): Promise<void> {
    await this.db.prepare("UPDATE push_subscriptions SET failures = 0 WHERE endpoint = ? AND failures > 0").bind(endpoint).run();
  }
}

export function pushStore(env: { DB?: D1Database }): PushStore | null {
  return env.DB ? new PushStore(env.DB) : null;
}

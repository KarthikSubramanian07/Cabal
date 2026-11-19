/**
 * Web Push on this device: whether it can work here, asking for permission, and registering the
 * browser's subscription with the server (`POST /api/me/push`). The browser's permission prompt
 * is only ever raised from a person's own click on a button that says what it is for; nothing
 * here asks on load.
 *
 * The browser objects are passed in, so the logic is tested without a browser.
 */

export type PushState =
  /** No service worker, no Push API or no Notification API: nothing to offer. */
  | "unsupported"
  /** iOS and iPadOS deliver push only to a web app added to the Home Screen. */
  | "needs-install"
  /** The person blocked notifications for this site; only the browser's settings can undo it. */
  | "denied"
  /** Allowed, or not yet asked, and this device is not subscribed. */
  | "off"
  /** This device is subscribed. */
  | "on";

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  permission: NotificationPermission | null;
  /** Running as an installed app (display-mode: standalone). */
  standalone: boolean;
  /** An iPhone or iPad, where push needs the installed app. */
  ios: boolean;
}

export function browserPushEnv(): PushEnv {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const ua = nav?.userAgent ?? "";
  const ios = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
  let standalone = false;
  try {
    standalone = window.matchMedia("(display-mode: standalone)").matches || (nav as { standalone?: boolean } | null)?.standalone === true;
  } catch {
    standalone = false;
  }
  return {
    hasServiceWorker: Boolean(nav && "serviceWorker" in nav),
    hasPushManager: typeof window !== "undefined" && "PushManager" in window,
    permission: typeof Notification === "undefined" ? null : Notification.permission,
    standalone,
    ios,
  };
}

/** What can be offered on this device, before knowing whether it is subscribed. */
export function pushState(env: PushEnv, subscribed: boolean): PushState {
  if (env.ios && !env.standalone && (!env.hasPushManager || env.permission === null)) return "needs-install";
  if (!env.hasServiceWorker || !env.hasPushManager || env.permission === null) return "unsupported";
  if (env.permission === "denied") return "denied";
  return subscribed && env.permission === "granted" ? "on" : "off";
}

/** The VAPID public key, base64url as the server gives it, as the bytes `subscribe` takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((base64url.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** How long to wait for the service worker before saying push is not available here. */
const READY_MS = 8000;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), READY_MS));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

/**
 * The browser's subscription for this site, if it holds one. Asks for the registration that
 * already exists rather than waiting for the worker to be ready, so a device without one (or with
 * service workers blocked) answers at once.
 */
export async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    if (!("serviceWorker" in navigator)) return null;
    const sw = navigator.serviceWorker;
    const reg = typeof sw.getRegistration === "function" ? await sw.getRegistration() : await registration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

export type TurnOnResult = { ok: true; devices: number; endpoint: string } | { ok: false; why: "denied" | "dismissed" | "unavailable" | "server-off"; detail?: string | undefined };

/**
 * Ask the browser for permission (from the click that called this), subscribe, and tell the
 * server. `register` sends the subscription; `publicKey` fetches the server's key.
 */
export async function turnOnPush(deps: {
  publicKey: () => Promise<string | null>;
  register: (subscription: PushSubscriptionJSON) => Promise<{ devices: number }>;
}): Promise<TurnOnResult> {
  const key = await deps.publicKey();
  if (!key) return { ok: false, why: "server-off" };
  const permission = await Notification.requestPermission();
  if (permission === "denied") return { ok: false, why: "denied" };
  if (permission !== "granted") return { ok: false, why: "dismissed" };
  const reg = await registration();
  if (!reg) return { ok: false, why: "unavailable", detail: "The app's service worker is not running on this page. Reload and try again." };
  const wanted = keyBytes(key);
  let sub: PushSubscription;
  try {
    let held: PushSubscription | null = null;
    try {
      held = await reg.pushManager.getSubscription();
    } catch {
      held = null;
    }
    // A subscription made under another server key (the key was rotated since) is refused by the
    // push service for every message signed with this one: replace it rather than register it.
    if (held && !sameKey(held.options?.applicationServerKey ?? null, wanted)) {
      await held.unsubscribe().catch(() => false);
      held = null;
    }
    sub = held ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted }));
  } catch (error) {
    return { ok: false, why: "unavailable", detail: error instanceof Error ? error.message : undefined };
  }
  const { devices } = await deps.register(sub.toJSON());
  return { ok: true, devices, endpoint: sub.endpoint };
}

/** Whether a subscription's server key is `wanted`. A browser that does not say is taken at its word. */
export function sameKey(held: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (held === null) return true;
  const bytes = new Uint8Array(held);
  return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i]);
}

export async function turnOffPush(unregister: (endpoint: string) => Promise<unknown>): Promise<void> {
  forgetPushOwner();
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await unregister(sub.endpoint);
  } finally {
    await sub.unsubscribe().catch(() => false);
  }
}

// ---- which account this device's subscription was registered for

const OWNER_KEY = "cabal.push.owner";

/**
 * The browser keeps one subscription for the site whoever is signed in. Remember which account
 * registered it, so a device that changed hands does not tell its new player that notifications
 * are on when the server sends them to nobody.
 */
export function markPushOwner(playerId: string, endpoint: string): void {
  try {
    localStorage.setItem(OWNER_KEY, JSON.stringify({ playerId, endpoint }));
  } catch {
    // remembered for this visit only
  }
}

export function pushOwner(): { playerId: string; endpoint: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(OWNER_KEY) ?? "null") as { playerId?: unknown; endpoint?: unknown } | null;
    return v && typeof v.playerId === "string" && typeof v.endpoint === "string" ? { playerId: v.playerId, endpoint: v.endpoint } : null;
  } catch {
    return null;
  }
}

export function forgetPushOwner(): void {
  try {
    localStorage.removeItem(OWNER_KEY);
  } catch {
    // nothing to forget
  }
}

/** On for this account: the browser holds a subscription, and this account is the one that registered it. */
export function subscribedFor(playerId: string | null, endpoint: string | null, owner = pushOwner()): boolean {
  return playerId !== null && endpoint !== null && owner !== null && owner.playerId === playerId && owner.endpoint === endpoint;
}

// ---- the offer made after a meaningful action

const OFFER_KEY = "cabal.push.offer";

/** The player said "Not now" (or turned push on): the in-game offer stays away from then on. */
export function offerDismissed(): boolean {
  try {
    return localStorage.getItem(OFFER_KEY) !== null;
  } catch {
    return true;
  }
}

export function dismissOffer(): void {
  try {
    localStorage.setItem(OFFER_KEY, String(Date.now()));
  } catch {
    // asked again next visit
  }
}

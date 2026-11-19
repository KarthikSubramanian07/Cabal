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

export async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    const reg = await registration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

export type TurnOnResult = { ok: true; devices: number } | { ok: false; why: "denied" | "dismissed" | "unavailable" | "server-off"; detail?: string | undefined };

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
  let sub: PushSubscription;
  try {
    sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  } catch (error) {
    return { ok: false, why: "unavailable", detail: error instanceof Error ? error.message : undefined };
  }
  const { devices } = await deps.register(sub.toJSON());
  return { ok: true, devices };
}

export async function turnOffPush(unregister: (endpoint: string) => Promise<unknown>): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await unregister(sub.endpoint);
  } finally {
    await sub.unsubscribe().catch(() => false);
  }
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

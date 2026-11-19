/**
 * Cabal's service worker, bundled by scripts/emit-agent-site.mjs into `dist/sw.js` after every
 * build with this build's version and precache list written in. Because both change whenever
 * any hashed file changes, every deploy ships a byte-different worker and the browser installs
 * it; the page then offers a reload (src/pwa/register.ts). It never takes over on its own.
 */
import { createWorker } from "./handlers.js";
import { notificationFor, pickClient } from "./push.js";

declare const __CABAL_SW__: { version: string; precache: string[] };

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

interface PushEvent extends ExtendableEvent {
  data: { json(): unknown } | null;
}

interface WindowClientLike {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}

interface NotificationEventLike extends ExtendableEvent {
  notification: { close(): void; data: { url?: string } | null };
}

interface WorkerScope {
  location: Location;
  caches: CacheStorage;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  registration: { showNotification(title: string, options: object): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEventLike) => void): void;
}

const scope = self as unknown as WorkerScope;

const worker = createWorker({
  version: __CABAL_SW__.version,
  precache: __CABAL_SW__.precache,
  caches: scope.caches,
  fetch: (request) => fetch(request),
  origin: scope.location.origin,
});

scope.addEventListener("install", (event) => {
  // No skipWaiting here: a new build waits until the player says so, so a page that is open
  // never has its files swapped under it mid-game.
  event.waitUntil(worker.install());
});

scope.addEventListener("activate", (event) => {
  event.waitUntil(worker.activate().then(() => scope.clients.claim()));
});

scope.addEventListener("message", (event) => {
  if ((event.data as { type?: unknown } | null)?.type === "SKIP_WAITING") void scope.skipWaiting();
});

scope.addEventListener("fetch", (event) => {
  const answer = worker.respond(event.request);
  if (answer) event.respondWith(answer);
});

// Web Push: the server says what happened in a game while this player was away from it.
scope.addEventListener("push", (event) => {
  let data: unknown = null;
  try {
    data = event.data?.json() ?? null;
  } catch {
    data = null;
  }
  const shown = notificationFor(data, scope.location.origin);
  if (shown) event.waitUntil(scope.registration.showNotification(shown.title, shown.options));
});

scope.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url ?? "/";
  event.waitUntil(
    scope.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const pick = pickClient(clients, path, scope.location.origin);
      if (!pick) return scope.clients.openWindow(path);
      if (pick.navigate) await pick.client.navigate(path);
      return pick.client.focus();
    }),
  );
});

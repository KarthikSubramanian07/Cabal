/**
 * Cabal's service worker, bundled by scripts/emit-agent-site.mjs into `dist/sw.js` after every
 * build with this build's version and precache list written in. Because both change whenever
 * any hashed file changes, every deploy ships a byte-different worker and the browser installs
 * it; the page then offers a reload (src/pwa/register.ts). It never takes over on its own.
 */
import { createWorker } from "./handlers.js";

declare const __CABAL_SW__: { version: string; precache: string[] };

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

interface WorkerScope {
  location: Location;
  caches: CacheStorage;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
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

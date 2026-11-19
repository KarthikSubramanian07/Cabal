/**
 * What the service worker may do with a request. Pure, so every rule is unit tested.
 *
 * The rules, in the order they are applied:
 *
 *  1. Anything that is not a same-origin GET is left to the network: no other site, no POST.
 *  2. `/api/*` is never touched. Game state, seat tokens and sockets are live; a cached answer
 *     would be a lie, and an HTML answer to an API call would break its JSON parse.
 *  3. A request that prefers Markdown (an agent reading the site) is left to the edge, which
 *     negotiates it.
 *  4. Navigations go to the network first, always. Only when the network fails outright does an
 *     app route get the app shell this worker installed with; trust pages and unknown paths fail
 *     honestly. A slow network is waited for, never answered with an old shell.
 *  5. Files under `/assets/` carry a content hash in their name, so a stored copy can never be
 *     stale: they are served from the cache first and stored once fetched.
 *  6. The few unhashed files the shell needs offline (icons, manifest) go to the network first
 *     and fall back to the copy from install.
 *  7. Everything else is left to the network.
 */
import { matchRoute } from "../app/routes.js";

export const CACHE_PREFIX = "cabal-";

/** The key the installed app shell is stored under. */
export const SHELL = "/index.html";

/** Unhashed files kept for offline use; they are precached at install alongside the shell. */
export const SHELL_FILES = ["/favicon.svg", "/site.webmanifest", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

export type Strategy = "pass" | "navigate" | "asset" | "static";

export interface RequestFacts {
  method: string;
  url: string;
  mode: string;
  /** The `Accept` header, or empty. */
  accept: string;
}

/** True when the request asks for Markdown ahead of HTML. */
function prefersMarkdown(accept: string): boolean {
  const md = /text\/markdown/i.exec(accept);
  if (!md) return false;
  const html = /text\/html/i.exec(accept);
  return !html || md.index < html.index;
}

export function classify(req: RequestFacts, origin: string): Strategy {
  if (req.method !== "GET") return "pass";
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return "pass";
  }
  if (url.origin !== origin) return "pass";
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/")) return "pass";
  if (path === "/sw.js") return "pass";
  if (prefersMarkdown(req.accept)) return "pass";
  if (req.mode === "navigate") return "navigate";
  if (path.startsWith("/assets/")) return "asset";
  if (SHELL_FILES.includes(path)) return "static";
  return "pass";
}

/** Whether a navigation that failed may be answered with the app shell. */
export function shellServes(url: string): boolean {
  try {
    return matchRoute(new URL(url).pathname) !== null;
  } catch {
    return false;
  }
}

/**
 * Only a complete, successful, same-origin answer is worth keeping. A 404, a 500, a partial 206,
 * a redirect or an opaque response stored once would be replayed forever.
 */
export function cacheable(res: { ok: boolean; status: number; type: string; redirected?: boolean }): boolean {
  return res.ok && res.status === 200 && res.type === "basic" && !res.redirected;
}

/** The cache for one build. */
export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** Caches from other builds, to delete once this one is active. */
export function staleCaches(names: readonly string[], version: string): string[] {
  const current = cacheName(version);
  return names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== current);
}

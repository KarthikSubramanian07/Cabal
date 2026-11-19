/**
 * The service worker's work, with the cache store and the network passed in, so it runs under
 * test without a browser. worker.ts wires it to the real events.
 */
import { SHELL, cacheName, cacheable, classify, shellServes, staleCaches } from "./policy.js";

export interface CacheLike {
  match(request: Request | string, options?: { ignoreVary?: boolean }): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
  addAll(requests: (Request | string)[]): Promise<void>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export interface WorkerDeps {
  /** Changes with every build: the hash of what is precached. */
  version: string;
  /** Paths to store at install: the shell, its unhashed files and the hashed build output. */
  precache: readonly string[];
  caches: CacheStorageLike;
  fetch: (request: Request | string) => Promise<Response>;
  origin: string;
}

export function createWorker(deps: WorkerDeps) {
  const name = cacheName(deps.version);
  const open = () => deps.caches.open(name);

  /** Store this build. `cache: reload` skips the HTTP cache, so install never stores an old copy. */
  async function install(): Promise<void> {
    const cache = await open();
    await cache.addAll(deps.precache.map((path) => new Request(new URL(path, deps.origin).href, { cache: "reload" })));
  }

  /** Remove every other build's cache. */
  async function activate(): Promise<void> {
    const stale = staleCaches(await deps.caches.keys(), deps.version);
    await Promise.all(stale.map((n) => deps.caches.delete(n)));
  }

  async function store(request: Request, response: Response): Promise<void> {
    if (!cacheable(response)) return;
    try {
      const cache = await open();
      await cache.put(request, response.clone());
    } catch {
      // A full disk or a refused write only means the next visit fetches it again.
    }
  }

  async function navigate(request: Request): Promise<Response> {
    try {
      return await deps.fetch(request);
    } catch (error) {
      if (shellServes(request.url)) {
        const shell = await (await open()).match(SHELL);
        if (shell) return shell;
      }
      throw error;
    }
  }

  /**
   * A hashed file never changes, so a stored copy answers whatever headers asked for it. Without
   * `ignoreVary` a server that answers `Vary: Origin` would miss for a module script (sent with an
   * Origin header) the copy stored at install (sent without one), and the offline app would not start.
   */
  async function asset(request: Request): Promise<Response> {
    const cached = await (await open()).match(request, { ignoreVary: true });
    if (cached) return cached;
    const response = await deps.fetch(request);
    await store(request, response);
    return response;
  }

  async function staticFile(request: Request): Promise<Response> {
    try {
      const response = await deps.fetch(request);
      if (response.ok) return response;
      const cached = await (await open()).match(request);
      return cached ?? response;
    } catch (error) {
      const cached = await (await open()).match(request);
      if (cached) return cached;
      throw error;
    }
  }

  /** The answer to a fetch, or null to let the browser go to the network untouched. */
  function respond(request: Request): Promise<Response> | null {
    const strategy = classify(
      { method: request.method, url: request.url, mode: request.mode, accept: request.headers.get("accept") ?? "" },
      deps.origin,
    );
    if (strategy === "navigate") return navigate(request);
    if (strategy === "asset") return asset(request);
    if (strategy === "static") return staticFile(request);
    return null;
  }

  return { install, activate, respond, cacheName: name };
}

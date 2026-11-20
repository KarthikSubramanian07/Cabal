/**
 * Registers the service worker in production builds and watches for a newer one. A new build
 * installs in the background and then waits; the page shows a quiet "new version" prompt, and
 * only when the player chooses Reload does the waiting worker take over and the page reload.
 * Nothing is swapped under an open game unasked.
 *
 * Registration is skipped under `vite dev`, where a worker would fight hot reload.
 */

export interface UpdateState {
  /** A newer build is installed and waiting for the player's word. */
  waiting: boolean;
}

type Listener = () => void;

/** The parts of the browser this needs, so it can be tested with fakes. */
export interface ContainerLike {
  readonly controller: unknown;
  register(url: string, options: { scope: string; updateViaCache: "none" }): Promise<RegistrationLike>;
  addEventListener(type: "controllerchange", listener: () => void): void;
}

export interface WorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}

export interface RegistrationLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  update(): Promise<unknown>;
  addEventListener(type: "updatefound", listener: () => void): void;
}

export function createUpdater(container: ContainerLike, reload: () => void) {
  let waiting: WorkerLike | null = null;
  let reloading = false;
  let snapshot: UpdateState = { waiting: false };
  const listeners = new Set<Listener>();

  function set(worker: WorkerLike | null) {
    waiting = worker;
    snapshot = { waiting: worker !== null };
    for (const l of listeners) l();
  }

  /** Watch a registration for a build that has installed behind the one in charge. */
  function watch(registration: RegistrationLike | undefined): void {
    // A browser that only pretends to register (an automated one with workers blocked resolves
    // with nothing) has nothing to watch.
    if (!registration) return;
    // A worker waiting with nobody in charge is the very first install: there is nothing to update.
    if (registration.waiting && container.controller) set(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const next = registration.installing;
      if (!next) return;
      next.addEventListener("statechange", () => {
        if (next.state === "installed" && container.controller) set(next);
      });
    });
  }

  // The first install also claims the page and fires this; only a reload the player asked for acts on it.
  container.addEventListener("controllerchange", () => {
    if (!reloading) return;
    reloading = false;
    reload();
  });

  return {
    watch,
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: (): UpdateState => snapshot,
    /** Let the waiting build take over; the page reloads once it has. */
    apply(): void {
      if (!waiting) return;
      reloading = true;
      waiting.postMessage({ type: "SKIP_WAITING" });
    },
    /** Hide the prompt for this visit. The build still waits, and is used on the next visit. */
    dismiss(): void {
      set(null);
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;

let updater: Updater | null = null;

/** The page's updater, or null where there is no service worker (dev, old browsers, tests). */
export function pageUpdater(): Updater | null {
  return updater;
}

/** How often an open tab asks whether a new build has been deployed. */
const CHECK_MS = 30 * 60_000;

/** What `connect` needs from the page, so it can be tested without one. */
export interface ConnectDeps {
  container: ContainerLike;
  updater: Updater;
  /** Run `check` every `ms` milliseconds. */
  every: (check: () => void, ms: number) => void;
  /** Run `check` whenever the page comes back into view. */
  onVisible: (check: () => void) => void;
  warn: (message: string, error?: unknown) => void;
}

/**
 * Register the worker and watch it for updates. Never rejects: the site works without a worker.
 *
 * `register()` is meant to resolve to a registration, but a browser that blocks service workers
 * (Playwright's `serviceWorkers: "block"`, some privacy modes) can resolve it to nothing at all.
 * That is treated as no worker, not as a registration to read.
 */
export async function connect({ container, updater, every, onVisible, warn }: ConnectDeps): Promise<void> {
  let registration: RegistrationLike | null | undefined;
  try {
    registration = await container.register("/sw.js", { scope: "/", updateViaCache: "none" });
  } catch (error) {
    // Say why offline play is missing for whoever is looking.
    warn("Cabal: the offline copy could not be set up.", error);
    return;
  }
  if (!registration || typeof registration !== "object") {
    warn("Cabal: the browser did not set up the offline copy.");
    return;
  }
  updater.watch(registration);
  const reg = registration;
  const check = () => {
    if (typeof reg.update !== "function") return;
    try {
      void Promise.resolve(reg.update()).catch(() => undefined);
    } catch {
      // A registration that has gone away; the next visit registers again.
    }
  };
  every(check, CHECK_MS);
  onVisible(check);
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker as unknown as ContainerLike;
  const current = createUpdater(container, () => window.location.reload());
  updater = current;
  const start = () =>
    void connect({
      container,
      updater: current,
      every: (check, ms) => window.setInterval(check, ms),
      onVisible: (check) =>
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") check();
        }),
      warn: (message, error) => console.warn(message, ...(error === undefined ? [] : [error])),
    });
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

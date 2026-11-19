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
  function watch(registration: RegistrationLike): void {
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

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker as unknown as ContainerLike;
  updater = createUpdater(container, () => window.location.reload());
  const start = () => {
    container.register("/sw.js", { scope: "/", updateViaCache: "none" }).then(
      (registration) => {
        updater?.watch(registration);
        const check = () => void registration.update().catch(() => undefined);
        window.setInterval(check, CHECK_MS);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") check();
        });
      },
      (error: unknown) => {
        // The site works without it; say why offline play is missing for whoever is looking.
        console.warn("Cabal: the offline copy could not be set up.", error);
      },
    );
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

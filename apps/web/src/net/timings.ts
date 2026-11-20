/**
 * The two phase 1 timings a browser can measure for itself (docs/PLAN.md section 8, issue #57),
 * sent to the server as anonymous beacons:
 *
 *  - `order_rtt`: an `orders.set` frame to its `orders.ack`, timed by the socket (`onReply`).
 *  - `landing_to_game`: from opening the front page to the first frame of a game whose movement
 *    phase accepts orders, once per visit that started at the front page.
 *
 * Samples wait in memory and go as one beacon (`POST /api/metrics`, at most 10 samples) when the
 * page is hidden or the batch is full. Nothing names the player or the device; the server adds only
 * the continent. The privacy page says so. Every browser API here is optional: a missing one (or one
 * that throws) costs the sample, never the page.
 */
import type { MetricSample } from "@cabal/protocol";

/** The most samples one beacon may carry (`MetricsBeacon`). */
export const BEACON_MAX = 10;
/** Where the start of a visit that opened at the front page is kept, for this tab only. */
export const LANDING_KEY = "cabal.landing-at";
/** A visit older than this is not timed: the schema's ceiling, and nobody waits an hour for a game. */
const LANDING_MAX_MS = 3_600_000;

export interface TimingDeps {
  now: () => number;
  /** `navigator.sendBeacon`, or undefined where the browser has none. */
  sendBeacon?: ((url: string, data: Blob) => boolean) | undefined;
  /** `sessionStorage`, or null where it is refused. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/** A frame as far as the landing timer cares: its type, and a welcome's or a state frame's status and phase. */
interface PhaseFrame {
  t: string;
  p?: object | undefined;
}

export function createTimings(deps: TimingDeps) {
  const queue: MetricSample[] = [];

  const read = (key: string): string | null => {
    try {
      return deps.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const drop = (key: string) => {
    try {
      deps.storage?.removeItem(key);
    } catch {
      // storage refused: nothing was kept to drop
    }
  };

  /** Send what is waiting as one beacon. Samples a refused beacon carried are let go, not retried. */
  function flush(): void {
    while (queue.length > 0) {
      const samples = queue.splice(0, BEACON_MAX);
      try {
        deps.sendBeacon?.("/api/metrics", new Blob([JSON.stringify({ samples })], { type: "application/json" }));
      } catch {
        // a beacon is best effort
      }
    }
  }

  function record(sample: MetricSample): void {
    if (!Number.isFinite(sample.ms) || sample.ms < 0) return;
    queue.push({ ...sample, ms: Math.round(sample.ms) });
    if (queue.length >= BEACON_MAX) flush();
  }

  /**
   * Called once as the app loads: a load of the front page starts the timer from the moment the
   * page began loading (a newer load replaces an older, unfinished one).
   */
  function markLanding(path: string, startedAt: number): void {
    if (path !== "/") return;
    try {
      deps.storage?.setItem(LANDING_KEY, String(Math.round(startedAt)));
    } catch {
      // storage refused: this visit is not timed
    }
  }

  /** Every frame a seated socket receives: the first game accepting orders ends the landing timer. */
  function noteFrame(frame: PhaseFrame): void {
    if (frame.t !== "welcome" && frame.t !== "state") return;
    const { status, phase } = (frame.p ?? {}) as { status?: unknown; phase?: unknown };
    if (status !== "active" || typeof phase !== "string" || !phase.endsWith("M")) return;
    const mark = read(LANDING_KEY);
    if (mark === null) return;
    drop(LANDING_KEY);
    const ms = deps.now() - Number(mark);
    if (Number.isFinite(ms) && ms >= 0 && ms <= LANDING_MAX_MS) record({ metric: "landing_to_game", ms });
  }

  /** The socket's `onReply`: only the order round trip is kept. */
  function noteReply(sent: string, ms: number): void {
    if (sent === "orders.set") record({ metric: "order_rtt", ms });
  }

  return { record, flush, markLanding, noteFrame, noteReply, pending: () => queue.length };
}

function browserTimings() {
  const has = typeof window !== "undefined";
  let storage: TimingDeps["storage"] = null;
  try {
    storage = has ? window.sessionStorage : null;
  } catch {
    storage = null;
  }
  return createTimings({
    now: () => Date.now(),
    sendBeacon: has && typeof navigator.sendBeacon === "function" ? (url, data) => navigator.sendBeacon(url, data) : undefined,
    storage,
  });
}

export const timings = browserTimings();

/**
 * Start timing this visit and send what was measured whenever the page is hidden (a closed tab, a
 * switched app, a phone locked): the last moment a page is sure to be able to send anything.
 */
export function startTimings(): void {
  if (typeof window === "undefined") return;
  timings.markLanding(window.location.pathname, performance.timeOrigin);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") timings.flush();
  });
  window.addEventListener("pagehide", () => timings.flush());
}

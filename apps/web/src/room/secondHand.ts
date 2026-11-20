/**
 * One shared second hand for every clock on the page, as a store for `useSyncExternalStore`: a
 * single timer however many clocks listen, and a reading that stays the same between ticks (the
 * store's snapshot must not change from one read to the next unless it has told its listeners).
 *
 * The reading is cached per tick and taken afresh whenever it could be stale: when the first
 * clock starts listening (after a pause, say, when nothing listened for minutes), when a clock
 * is drawn while nothing listens, and when the page comes back into view after the browser held
 * its timers back. So a clock never shows, even for one frame, the time it was when it stopped.
 */

type Listener = () => void;

/** Where the hand gets the time and its tick. A test passes its own. */
export interface Clockwork {
  now(): number;
  /** Call `fn` every `ms`; returns how to stop. */
  every(ms: number, fn: () => void): () => void;
  /** Call `fn` when the page comes back into view; returns how to stop. */
  wake?(fn: () => void): () => void;
}

export interface SecondHand {
  subscribe(listener: Listener): () => void;
  /** The time at the last tick (a stable snapshot). */
  read(): number;
}

export const browserClockwork: Clockwork = {
  now: () => Date.now(),
  every(ms, fn) {
    const id = window.setInterval(fn, ms);
    return () => window.clearInterval(id);
  },
  wake(fn) {
    const onVisible = () => {
      if (document.visibilityState === "visible") fn();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  },
};

export function createSecondHand(clock: Clockwork = browserClockwork, period = 1000): SecondHand {
  const listeners = new Set<Listener>();
  let reading = clock.now();
  let stop: (() => void) | null = null;
  let unwake: (() => void) | null = null;

  const tick = () => {
    reading = clock.now();
    for (const l of listeners) l();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (stop === null) {
        const before = reading;
        reading = clock.now();
        stop = clock.every(period, tick);
        unwake = clock.wake?.(tick) ?? null;
        // The clock was drawn with the reading it had; tell it the time has moved on.
        if (reading !== before) listener();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop !== null) {
          stop();
          unwake?.();
          stop = null;
          unwake = null;
        }
      };
    },
    read() {
      // While nothing listens the hand does not move, so a reading a tick old is stale: take it
      // again. Within a tick it is kept, so two reads in a row always agree.
      if (stop === null && clock.now() - reading >= period) reading = clock.now();
      return reading;
    },
  };
}

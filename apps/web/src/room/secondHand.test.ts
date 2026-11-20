import { describe, expect, it } from "vitest";
import { type Clockwork, createSecondHand } from "./secondHand.js";

/** A clock the test winds by hand: `at` is the time, `tick()` fires the timers, `show()` the page. */
interface Wound {
  at: number;
  timers: Set<() => void>;
  wakers: Set<() => void>;
  tick(): void;
  show(): void;
  works: Clockwork;
}

function clockwork(start = 1_000_000): Wound {
  const timers = new Set<() => void>();
  const wakers = new Set<() => void>();
  const c: Wound = {
    at: start,
    timers,
    wakers,
    tick: () => [...timers].forEach((fn) => fn()),
    show: () => [...wakers].forEach((fn) => fn()),
    works: {
      now: () => c.at,
      every(_ms: number, fn: () => void) {
        timers.add(fn);
        return () => timers.delete(fn);
      },
      wake(fn: () => void) {
        wakers.add(fn);
        return () => wakers.delete(fn);
      },
    },
  };
  return c;
}

describe("the second hand", () => {
  it("keeps one reading between ticks, so two reads in a row agree", () => {
    const c = clockwork();
    const hand = createSecondHand(c.works);
    const stop = hand.subscribe(() => undefined);
    const first = hand.read();
    c.at += 400;
    expect(hand.read()).toBe(first);
    expect(hand.read()).toBe(hand.read());
    c.at += 600;
    c.tick();
    expect(hand.read()).toBe(c.at);
    stop();
  });

  it("tells every listener at each tick, on one timer however many listen", () => {
    const c = clockwork();
    const hand = createSecondHand(c.works);
    let heard = 0;
    const stops = [1, 2, 3].map(() => hand.subscribe(() => (heard += 1)));
    expect(c.timers.size).toBe(1);
    c.at += 1000;
    c.tick();
    expect(heard).toBe(3);
    stops.forEach((s) => s());
    expect(c.timers.size).toBe(0);
    expect(c.wakers.size).toBe(0);
  });

  it("reads the time now when a clock comes back after a pause, not the time it stopped", () => {
    const c = clockwork();
    const hand = createSecondHand(c.works);
    const stop = hand.subscribe(() => undefined);
    stop();
    // Five minutes of a paused game: nothing listened, nothing ticked.
    c.at += 5 * 60_000;
    // The resumed clock is drawn before it subscribes: that first frame must already be right.
    expect(hand.read()).toBe(c.at);
  });

  it("takes the reading again when the first clock subscribes, and says so if it moved", () => {
    const c = clockwork();
    const hand = createSecondHand(c.works);
    const drawn = hand.read();
    c.at += 300;
    let told = 0;
    const stop = hand.subscribe(() => (told += 1));
    expect(hand.read()).toBe(drawn + 300);
    expect(told).toBe(1);
    stop();
  });

  it("does not wake a clock that is already right", () => {
    const c = clockwork();
    const hand = createSecondHand(c.works);
    hand.read();
    let told = 0;
    const stop = hand.subscribe(() => (told += 1));
    expect(told).toBe(0);
    // A second clock joining a running hand reads the same time and is told nothing.
    c.at += 200;
    const other = hand.subscribe(() => (told += 1));
    expect(told).toBe(0);
    stop();
    other();
  });

  it("is a stable snapshot while nothing listens, too", () => {
    const c = clockwork();
    const hand = createSecondHand(c.works);
    const a = hand.read();
    c.at += 999;
    expect(hand.read()).toBe(a);
    c.at += 1;
    expect(hand.read()).toBe(a + 1000);
  });

  it("catches up at once when the page comes back into view", () => {
    const c = clockwork();
    const hand = createSecondHand(c.works);
    let told = 0;
    const stop = hand.subscribe(() => (told += 1));
    // A background tab: the browser held the timer back for a minute.
    c.at += 60_000;
    c.show();
    expect(hand.read()).toBe(c.at);
    expect(told).toBe(1);
    stop();
  });
});

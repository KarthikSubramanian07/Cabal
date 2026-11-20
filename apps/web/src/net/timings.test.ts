import { describe, expect, it } from "vitest";
import { BEACON_MAX, LANDING_KEY, createTimings } from "./timings.js";

function setup(opts: { storage?: boolean; beacon?: boolean } = {}) {
  let t = 1_000_000;
  const store = new Map<string, string>();
  const sent: unknown[] = [];
  const timings = createTimings({
    now: () => t,
    sendBeacon:
      opts.beacon === false
        ? undefined
        : (url, data) => {
            expect(url).toBe("/api/metrics");
            expect(data.type).toBe("application/json");
            sent.push(data);
            return true;
          },
    storage:
      opts.storage === false
        ? null
        : { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
  });
  const beacons = async () => Promise.all(sent.map(async (b) => JSON.parse(await (b as Blob).text()) as { samples: unknown[] }));
  return { timings, store, beacons, advance: (ms: number) => (t += ms) };
}

const welcome = (status: string, phase: string) => ({ t: "welcome", p: { status, phase } });

describe("order round trips", () => {
  it("keeps orders.set replies only, and sends nothing until the page is hidden", async () => {
    const { timings, beacons } = setup();
    timings.noteReply("orders.set", 41.6);
    timings.noteReply("press.send", 80);
    timings.noteReply("extend", 12);
    expect(await beacons()).toEqual([]);
    timings.flush();
    expect(await beacons()).toEqual([{ samples: [{ metric: "order_rtt", ms: 42 }] }]);
    timings.flush();
    expect(await beacons()).toHaveLength(1);
  });

  it("sends a full batch at once, never more than a beacon may carry", async () => {
    const { timings, beacons } = setup();
    for (let i = 0; i < BEACON_MAX + 3; i++) timings.noteReply("orders.set", 10 + i);
    const sent = await beacons();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.samples).toHaveLength(BEACON_MAX);
    expect(timings.pending()).toBe(3);
  });

  it("drops what the browser cannot send, without throwing", () => {
    const { timings } = setup({ beacon: false });
    timings.noteReply("orders.set", 30);
    expect(() => timings.flush()).not.toThrow();
    expect(timings.pending()).toBe(0);
  });
});

describe("landing to a game in progress", () => {
  it("times a visit that opened at the front page to the first game accepting orders, once", async () => {
    const { timings, store, advance, beacons } = setup();
    timings.markLanding("/", 1_000_000);
    expect(store.get(LANDING_KEY)).toBe("1000000");
    advance(12_345);
    // A lobby, a retreat and a spectator's game over do not end the timer.
    timings.noteFrame(welcome("lobby", "S1901M"));
    timings.noteFrame({ t: "state", p: { status: "active", phase: "F1901R" } });
    timings.noteFrame({ t: "seats", p: { status: "active", phase: "S1901M" } });
    expect(timings.pending()).toBe(0);
    timings.noteFrame({ t: "state", p: { status: "active", phase: "S1901M" } });
    timings.noteFrame(welcome("active", "F1901M"));
    timings.flush();
    expect(await beacons()).toEqual([{ samples: [{ metric: "landing_to_game", ms: 12_345 }] }]);
    expect(store.has(LANDING_KEY)).toBe(false);
  });

  it("does not time a visit that began anywhere else, or one older than an hour", () => {
    const { timings, advance } = setup();
    timings.markLanding("/games", 1_000_000);
    timings.noteFrame(welcome("active", "S1901M"));
    expect(timings.pending()).toBe(0);
    timings.markLanding("/", 1_000_000);
    advance(3_600_001);
    timings.noteFrame(welcome("active", "S1901M"));
    expect(timings.pending()).toBe(0);
  });

  it("does nothing where session storage is refused", () => {
    const { timings } = setup({ storage: false });
    timings.markLanding("/", 1_000_000);
    timings.noteFrame(welcome("active", "S1901M"));
    expect(timings.pending()).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOUND_NAMES } from "./cues.js";
import { type DeckContext, createDeck } from "./deck.js";
import { PEAK, VOICES, rng } from "./voices.js";

/** A context that records what the voices build and schedule. */
function fakeContext() {
  const started: { kind: string; at: number; stop: number }[] = [];
  const peaks: number[] = [];
  /** Only gains are levels; frequencies ramp too but are not loudness. */
  const param = (level = false) => ({
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn((v: number) => (level ? peaks.push(v) : 0)),
    linearRampToValueAtTime: vi.fn(),
  });
  const node = () => ({ connect: vi.fn((n: unknown) => n) });
  const source = (kind: string) => {
    const s = {
      ...node(),
      kind,
      buffer: null as unknown,
      type: "",
      frequency: param(),
      start: vi.fn((at: number) => started.push({ kind, at, stop: Number.NaN })),
      stop: vi.fn((at: number) => {
        const last = started.at(-1);
        if (last) last.stop = at;
      }),
    };
    return s;
  };
  const ctx = {
    currentTime: 10,
    sampleRate: 8000,
    state: "running",
    destination: node(),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    createGain: () => ({ ...node(), gain: param(true) }),
    createOscillator: () => source("osc"),
    createBufferSource: () => source("noise"),
    createBiquadFilter: () => ({ ...node(), type: "", frequency: param(), Q: param() }),
    createBuffer: (_c: number, length: number) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    },
  };
  return { ctx: ctx as unknown as DeckContext, started, peaks };
}

describe("the voices", () => {
  it.each(SOUND_NAMES)("%s starts its sources and stops every one of them within a second", (name) => {
    const { ctx, started, peaks } = fakeContext();
    const out = { connect: vi.fn() } as unknown as AudioNode;
    const sources = VOICES[name](ctx, out, 10, 1, rng(1));
    expect(sources.length).toBeGreaterThan(0);
    expect(started.length).toBe(sources.length);
    for (const s of started) {
      expect(s.at).toBeGreaterThanOrEqual(10);
      expect(s.stop - 10).toBeLessThan(1);
    }
    // Never above the ceiling, whatever the weight.
    expect(Math.max(...peaks)).toBeLessThanOrEqual(PEAK);
  });

  it("hits harder for a heavier stamp", () => {
    const light = fakeContext();
    const heavy = fakeContext();
    const out = { connect: vi.fn() } as unknown as AudioNode;
    VOICES.thud(light.ctx, out, 0, 1, rng(1));
    VOICES.thud(heavy.ctx, out, 0, 1.4, rng(1));
    expect(Math.max(...heavy.peaks)).toBeGreaterThan(Math.max(...light.peaks));
  });

  it("makes the same noise every time", () => {
    const a = rng(1901);
    const b = rng(1901);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("the deck", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (saved: string | null = null, audible = true) => {
    const fake = fakeContext();
    const makeContext = vi.fn(() => fake.ctx);
    let stored = saved;
    const deck = createDeck({
      makeContext,
      store: { get: () => stored, set: (v) => (stored = v) },
      audible: () => audible,
      now: () => Date.now(),
    });
    return { deck, makeContext, fake, stored: () => stored };
  };

  it("is off by default and makes no audio context until it is turned on", () => {
    const { deck, makeContext } = make();
    expect(deck.enabled()).toBe(false);
    deck.play("thud");
    deck.schedule([{ at: 0, sound: "march" }]);
    vi.runAllTimers();
    expect(makeContext).not.toHaveBeenCalled();
  });

  it("remembers the choice on this device and confirms it with a tick", () => {
    const { deck, makeContext, fake, stored } = make();
    deck.setEnabled(true);
    expect(stored()).toBe("on");
    expect(makeContext).toHaveBeenCalledTimes(1);
    expect(fake.started.length).toBeGreaterThan(0);
    deck.setEnabled(false);
    expect(stored()).toBe("off");
    expect(fake.ctx.suspend).toHaveBeenCalled();
  });

  it("picks up a saved choice", () => {
    expect(make("on").deck.enabled()).toBe(true);
    expect(make("off").deck.enabled()).toBe(false);
  });

  it("plays a phase's cues in time, and a cancel silences the rest", () => {
    const { deck, fake } = make("on");
    const cancel = deck.schedule([
      { at: 0, sound: "crack" },
      { at: 500, sound: "march" },
      { at: 1500, sound: "thud" },
    ]);
    vi.advanceTimersByTime(600);
    const heard = fake.started.length;
    expect(heard).toBeGreaterThan(0);
    cancel();
    vi.advanceTimersByTime(2000);
    expect(fake.started.length).toBe(heard);
  });

  it("plays faster at a faster rate", () => {
    const { deck, fake } = make("on");
    deck.schedule([{ at: 1000, sound: "tick" }], { rate: 2 });
    vi.advanceTimersByTime(520);
    expect(fake.started.length).toBeGreaterThan(0);
  });

  it("starts part way into a run, dropping what came before (a speed changed mid-phase)", () => {
    const { deck, fake } = make("on");
    deck.schedule(
      [
        { at: 0, sound: "crack" },
        { at: 400, sound: "march" },
        { at: 1000, sound: "thud" },
      ],
      { rate: 0.5, from: 600 },
    );
    // Nothing before 600 ms of cue time is played again; the thud is 400 ms of cue time away,
    // which at half speed is 800 ms.
    vi.advanceTimersByTime(700);
    expect(fake.started.length).toBe(0);
    vi.advanceTimersByTime(150);
    expect(fake.started.length).toBeGreaterThan(0);
  });

  it("drops a repeat of the same sound in the same instant", () => {
    const { deck, fake } = make("on");
    deck.play("thud");
    const once = fake.started.length;
    deck.play("thud");
    expect(fake.started.length).toBe(once);
    vi.advanceTimersByTime(100);
    deck.play("thud");
    expect(fake.started.length).toBe(once * 2);
  });

  it("stays quiet in a hidden tab", () => {
    const { deck, fake } = make("on", false);
    deck.play("tick");
    expect(fake.started.length).toBe(0);
  });
});

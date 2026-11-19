/**
 * The five voices, built from oscillators and filtered noise with the Web Audio API. Original
 * sounds, no samples: each is a few nodes with short envelopes, so nothing rings on and every
 * source stops itself. Written against the small slice of the API they use, so the tests can
 * run them on a recording fake.
 *
 * Levels are kept low and close together: these sit under the game, never over it.
 */
import type { SoundName } from "./cues.js";

/** The parts of `AudioContext` the voices touch. */
export interface Ctx {
  readonly currentTime: number;
  readonly sampleRate: number;
  createGain(): GainNode;
  createOscillator(): OscillatorNode;
  createBiquadFilter(): BiquadFilterNode;
  createBufferSource(): AudioBufferSourceNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

/** Anything started by a voice, so a cancel can stop it. */
export type Source = Pick<AudioScheduledSourceNode, "stop">;

/** The loudest any voice gets before the deck's master gain. */
export const PEAK = 0.6;

/** A mulberry32 generator: the same noise every time, so the sounds (and the tests) are steady. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buffers = new WeakMap<object, AudioBuffer>();

/** Half a second of white noise, made once per context. */
export function noise(ctx: Ctx): AudioBuffer {
  let buf = buffers.get(ctx);
  if (!buf) {
    const length = Math.round(ctx.sampleRate * 0.5);
    buf = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const r = rng(1901);
    for (let i = 0; i < length; i++) data[i] = r() * 2 - 1;
    buffers.set(ctx, buf);
  }
  return buf;
}

/** A gain that rises to `peak` in `attack` seconds and dies away over `decay`. */
function envelope(ctx: Ctx, out: AudioNode, at: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.min(PEAK, peak), at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  g.connect(out);
  return g;
}

function burst(
  ctx: Ctx,
  out: AudioNode,
  at: number,
  opts: { type: BiquadFilterType; freq: number; q?: number; peak: number; attack: number; decay: number; offset?: number },
): Source {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = opts.type;
  f.frequency.setValueAtTime(opts.freq, at);
  f.Q.setValueAtTime(opts.q ?? 0.8, at);
  src.connect(f);
  f.connect(envelope(ctx, out, at, opts.peak, opts.attack, opts.decay));
  src.start(at, opts.offset ?? 0);
  src.stop(at + opts.attack + opts.decay + 0.02);
  return src;
}

function tone(
  ctx: Ctx,
  out: AudioNode,
  at: number,
  opts: { type: OscillatorType; from: number; to?: number; glide?: number; peak: number; attack: number; decay: number },
): Source {
  const osc = ctx.createOscillator();
  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.from, at);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, at + (opts.glide ?? opts.decay));
  osc.connect(envelope(ctx, out, at, opts.peak, opts.attack, opts.decay));
  osc.start(at);
  osc.stop(at + opts.attack + opts.decay + 0.02);
  return osc;
}

type Voice = (ctx: Ctx, out: AudioNode, at: number, weight: number, r: () => number) => Source[];

/** The stamp: a dull body falling in pitch, the slap of paper, the click of the rubber's edge. */
const thud: Voice = (ctx, out, at, weight, r) => {
  const w = Math.max(0.5, Math.min(1.6, weight));
  const body = 118 / Math.sqrt(w) * (0.96 + r() * 0.08);
  return [
    tone(ctx, out, at, { type: "sine", from: body, to: body * 0.42, glide: 0.12, peak: 0.42 * w, attack: 0.004, decay: 0.2 * w }),
    burst(ctx, out, at, { type: "lowpass", freq: 900, peak: 0.26 * w, attack: 0.002, decay: 0.05, offset: r() * 0.3 }),
    burst(ctx, out, at, { type: "highpass", freq: 3200, peak: 0.08, attack: 0.001, decay: 0.012, offset: r() * 0.3 }),
  ];
};

/** The nib: three strokes of narrow, bright noise, each pulled a little higher. */
const quill: Voice = (ctx, out, at, _w, r) => {
  const out_: Source[] = [];
  let t = at;
  for (let i = 0; i < 3; i++) {
    const len = 0.05 + r() * 0.04;
    out_.push(burst(ctx, out, t, { type: "bandpass", freq: 2600 + i * 450 + r() * 300, q: 3.2, peak: 0.07, attack: 0.012, decay: len, offset: r() * 0.3 }));
    t += len + 0.025 + r() * 0.02;
  }
  return out_;
};

/** The march: three paces, a soft low thump each, the last a touch lighter. */
const march: Voice = (ctx, out, at, _w, r) => {
  const out_: Source[] = [];
  for (let i = 0; i < 3; i++) {
    const t = at + i * 0.15;
    const level = i === 2 ? 0.7 : 1;
    out_.push(burst(ctx, out, t, { type: "lowpass", freq: 420, peak: 0.24 * level, attack: 0.004, decay: 0.07, offset: r() * 0.3 }));
    out_.push(tone(ctx, out, t, { type: "sine", from: 92 + r() * 8, to: 60, peak: 0.12 * level, attack: 0.003, decay: 0.06 }));
  }
  return out_;
};

/** The seal: a dry snap, two or three splinters after it, and the knock of wax on paper. */
const crack: Voice = (ctx, out, at, _w, r) => {
  const out_: Source[] = [burst(ctx, out, at, { type: "highpass", freq: 1800, peak: 0.22, attack: 0.001, decay: 0.03, offset: r() * 0.3 })];
  let t = at + 0.018;
  for (let i = 0; i < 2 + Math.round(r()); i++) {
    out_.push(burst(ctx, out, t, { type: "bandpass", freq: 2400 + r() * 1800, q: 1.6, peak: 0.09, attack: 0.001, decay: 0.012, offset: r() * 0.3 }));
    t += 0.014 + r() * 0.016;
  }
  out_.push(tone(ctx, out, at + 0.004, { type: "triangle", from: 640, to: 420, peak: 0.08, attack: 0.002, decay: 0.035 }));
  return out_;
};

/** The telegraph key: a short, clean dit with the click of the lever under it. */
const tick: Voice = (ctx, out, at) => [
  tone(ctx, out, at, { type: "sine", from: 1860, peak: 0.07, attack: 0.003, decay: 0.03 }),
  burst(ctx, out, at, { type: "highpass", freq: 4000, peak: 0.05, attack: 0.001, decay: 0.006 }),
];

export const VOICES: Record<SoundName, Voice> = { thud, quill, march, crack, tick };

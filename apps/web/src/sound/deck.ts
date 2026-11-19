/**
 * The sound deck: one per page, off until the player turns it on.
 *
 * - Off by default. The choice is kept on this device (`cabal.sound`).
 * - No audio context exists until sound is switched on, and it is only ever made in answer to
 *   that tap, so browsers never block it and nothing is decoded for a player who keeps quiet.
 * - The page asks to be "ambient" audio where the browser lets it (Safari's Audio Session API),
 *   so the phone's silent switch silences it and it never stops the player's music.
 * - Nothing plays in a hidden tab; the context is suspended there and resumed on return.
 * - A burst of the same sound within a few milliseconds plays once.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { Cue, SoundName } from "./cues.js";
import { type Ctx, type Source, VOICES, rng } from "./voices.js";

export const SOUND_KEY = "cabal.sound";
/** The deck's overall level. Kept low on purpose. */
export const MASTER = 0.55;
/** The same sound again within this long is dropped. */
export const DEBOUNCE_MS = 35;

export interface DeckContext extends Ctx {
  readonly destination: AudioNode;
  readonly state: string;
  resume(): Promise<void>;
  suspend(): Promise<void>;
}

interface Store {
  get(): string | null;
  set(value: string): void;
}

export interface Deck {
  /** Whether sound is on. */
  enabled(): boolean;
  /** Turn sound on or off. Call from the tap that asked for it: that is what lets audio start. */
  setEnabled(on: boolean): void;
  /** Play one sound now, or `delayMs` from now. */
  play(sound: SoundName, opts?: { delayMs?: number; weight?: number }): void;
  /** Play a run of cues (a phase's choreography). `rate` above 1 plays them faster. Returns a cancel. */
  schedule(cues: readonly Cue[], opts?: { rate?: number }): () => void;
  subscribe(listener: () => void): () => void;
}

export interface DeckOptions {
  makeContext: () => DeckContext | null;
  store?: Store;
  /** Whether the page can be heard right now (a visible tab). */
  audible?: () => boolean;
  now?: () => number;
  /** Suspend the context while the tab is hidden (browser only). */
  watchVisibility?: boolean;
}

export function createDeck(options: DeckOptions): Deck {
  const listeners = new Set<() => void>();
  const store = options.store;
  const audible = options.audible ?? (() => true);
  const now = options.now ?? (() => Date.now());
  let on: boolean | undefined;
  let ctx: DeckContext | null = null;
  let master: GainNode | null = null;
  const last = new Map<SoundName, number>();
  const live = new Set<Source>();
  const random = rng(7);

  if (options.watchVisibility && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!ctx) return;
      if (document.visibilityState === "hidden") void ctx.suspend().catch(() => {});
      else if (on) void ctx.resume().catch(() => {});
    });
  }

  const read = () => {
    if (on === undefined) {
      try {
        on = store?.get() === "on";
      } catch {
        on = false;
      }
    }
    return on;
  };

  const context = (): DeckContext | null => {
    if (!ctx) {
      ctx = options.makeContext();
      if (!ctx) return null;
      master = ctx.createGain();
      master.gain.setValueAtTime(MASTER, ctx.currentTime);
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  };

  const voice = (sound: SoundName, delayMs: number, weight: number) => {
    if (!read() || !audible()) return;
    const at = now() + delayMs;
    const prev = last.get(sound);
    if (prev !== undefined && Math.abs(at - prev) < DEBOUNCE_MS) return;
    last.set(sound, at);
    const c = context();
    if (!c || !master) return;
    for (const s of VOICES[sound](c, master, c.currentTime + Math.max(0, delayMs) / 1000 + 0.005, weight, random)) {
      live.add(s);
      // Forget each source once it is certainly over.
      setTimeout(() => live.delete(s), delayMs + 1500);
    }
  };

  return {
    enabled: read,
    setEnabled(next) {
      on = next;
      try {
        store?.set(next ? "on" : "off");
      } catch {
        // storage can be unavailable (private windows); the choice still holds for this visit
      }
      if (next) {
        context();
        voice("tick", 0, 1);
      } else {
        for (const s of live) {
          try {
            s.stop();
          } catch {
            // already stopped
          }
        }
        live.clear();
        if (ctx && ctx.state === "running") void ctx.suspend().catch(() => {});
      }
      for (const l of listeners) l();
    },
    play(sound, opts) {
      voice(sound, opts?.delayMs ?? 0, opts?.weight ?? 1);
    },
    schedule(cues, opts) {
      if (!read() || cues.length === 0) return () => {};
      const rate = opts?.rate && opts.rate > 0 ? opts.rate : 1;
      // Cues are released a little ahead of time rather than all at once, so a cancel (a skip,
      // a step to another phase) silences what has not been heard yet.
      const timers = cues.map((cue) =>
        setTimeout(() => voice(cue.sound, 0, cue.weight ?? 1), Math.max(0, cue.at / rate - 20)),
      );
      return () => timers.forEach(clearTimeout);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function browserContext(): DeckContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  // Behave like the other sounds on the phone: obey the silent switch and mix with music.
  const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
  if (session) {
    try {
      session.type = "ambient";
    } catch {
      // older engines refuse the assignment
    }
  }
  try {
    return new Ctor({ latencyHint: "interactive" }) as unknown as DeckContext;
  } catch {
    return null;
  }
}

/** The page's deck. */
export const deck: Deck = createDeck({
  makeContext: browserContext,
  store: {
    get: () => localStorage.getItem(SOUND_KEY),
    set: (v) => localStorage.setItem(SOUND_KEY, v),
  },
  audible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  watchVisibility: true,
});

/** Whether sound is on, and the switch. */
export function useSound(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(deck.subscribe, deck.enabled, () => false);
  const set = useCallback((next: boolean) => deck.setEnabled(next), []);
  return [value, set];
}

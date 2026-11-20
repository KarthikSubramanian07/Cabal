/**
 * The Ledger at the table: each signed-in player's trust score, read from their public record and
 * shown on their seat, so a player weighing an offer knows whose word it is.
 *
 * A score moves when a rated game the player is in ends (this one, or any other they play), so a
 * figure is kept for the visit and looked at again when it could have moved: when a phase turns
 * (`refreshTrust`, from the room), when the page comes back into view, and a moment after this
 * game ends, once its result has reached the players' records. A figure younger than
 * `TRUST_STALE_MS` is not fetched again for a phase or a return to the page; the end of the game
 * always is, past the browser's cache. While a figure is fetched again the old one stays shown,
 * and a failed look-up keeps it.
 */
import type { TrustView } from "@cabal/protocol";
import { createApi } from "@cabal/protocol/client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../net/api.js";
import { percent } from "../profile/record.js";

/** How old a figure may be before a phase turning or a return to the page fetches it again. */
export const TRUST_STALE_MS = 60_000;
/** How long after the game ends its result takes to reach the players' records, give or take. */
export const TRUST_SETTLE_MS = 4_000;

/** One look-up: fresh asks past the browser's cache (a profile may be cached for half a minute). */
export type TrustFetch = (handle: string, fresh: boolean) => Promise<TrustView>;

/** Profiles past the browser's cache, for the look-up after a game ends. */
const freshApi = createApi({ baseUrl: "", fetch: (input, init) => fetch(input, { ...init, cache: "no-cache" }) });
const fetchTrust: TrustFetch = (handle, fresh) => (fresh ? freshApi : api).profile(handle).then((p) => p.trust);

interface Entry {
  /** When this look-up was asked for. */
  at: number;
  hit: Promise<TrustView | null>;
}
const known = new Map<string, Entry>();

export interface TrustLookUp {
  /** A figure older than this is fetched again; by default one is fetched once per visit. */
  maxAge?: number;
  /** Past the browser's cache. */
  fresh?: boolean;
  fetch?: TrustFetch;
  now?: number;
}

/**
 * One player's trust. A look-up younger than `maxAge` (by default, any) is shared; an older one is
 * made again, and until it answers, or if it fails, the figure it replaces is the answer. A failed
 * first look-up is forgotten, so it is tried again next time.
 */
export function lookUpTrust(handle: string, options: TrustLookUp = {}): Promise<TrustView | null> {
  const { maxAge = Infinity, fresh = false, fetch = fetchTrust, now = Date.now() } = options;
  const key = handle.toLowerCase();
  const before = known.get(key);
  if (before && now - before.at <= maxAge) return before.hit;
  const entry: Entry = {
    at: now,
    hit: fetch(handle, fresh).catch(async () => {
      const kept = before ? await before.hit : null;
      // Put the older look-up back (with its age), or forget it all, so the next turn tries again.
      if (known.get(key) === entry) {
        if (before) known.set(key, before);
        else known.delete(key);
      }
      return kept;
    }),
  };
  known.set(key, entry);
  return entry.hit;
}

/** Forget every look-up (tests). */
export function forgetTrust(): void {
  known.clear();
  moment = { n: 0, fresh: false };
}

// ---- the moments a figure may have moved, told by the room to every seat on the page

interface Moment {
  n: number;
  /** Look again past every cache: the game has just ended. */
  fresh: boolean;
}
let moment: Moment = { n: 0, fresh: false };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A figure on a seat may have moved: look again at those older than `TRUST_STALE_MS`, or at every one when `fresh`. */
export function refreshTrust(options: { fresh?: boolean } = {}): void {
  moment = { n: moment.n + 1, fresh: Boolean(options.fresh) };
  for (const l of listeners) l();
}

/**
 * The room's part: a phase turning is a moment trust may have moved (another game of a player's
 * may have ended), and the end of this game certainly is, once its result has been recorded.
 */
export function useTrustMoments(phase: string, over: boolean): void {
  // As the room was when this visit began: a game already over when it is opened is looked up as usual.
  const [start] = useState({ phase, over });
  useEffect(() => {
    if (phase !== start.phase) refreshTrust();
  }, [phase, start]);
  useEffect(() => {
    if (!over || start.over) return;
    const timer = window.setTimeout(() => refreshTrust({ fresh: true }), TRUST_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [over, start]);
}

/** Trust per handle, lower-cased, for the signed-in players among `handles`. */
export function useTrust(handles: readonly (string | null | undefined)[]): Record<string, TrustView> {
  const list = useMemo(() => [...new Set(handles.filter((h): h is string => Boolean(h)).map((h) => h.toLowerCase()))].sort(), [handles]);
  const key = list.join(" ");
  const [trust, setTrust] = useState<Record<string, TrustView>>({});
  const latest = useSyncExternalStore(subscribe, () => moment, () => moment);
  /** The last moment these seats looked for; a new one since means look again. */
  const seen = useRef(latest.n);
  useEffect(() => {
    let live = true;
    const look = (options: TrustLookUp) => {
      for (const handle of key ? key.split(" ") : []) {
        void lookUpTrust(handle, options).then((t) => {
          if (live && t) setTrust((current) => (current[handle] === t ? current : { ...current, [handle]: t }));
        });
      }
    };
    const told = latest.n !== seen.current;
    seen.current = latest.n;
    look(told ? (latest.fresh ? { maxAge: 0, fresh: true } : { maxAge: TRUST_STALE_MS }) : {});
    // Coming back to the page after a while away: whatever ended meanwhile.
    const back = () => {
      if (document.visibilityState === "visible") look({ maxAge: TRUST_STALE_MS });
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", back);
    };
  }, [key, latest]);
  return trust;
}

/** The figure on a seat: `72%`. */
export function trustFigure(t: TrustView): string {
  return percent(t.score);
}

/** The words beside it: how many promises the figure stands on. */
export function trustNote(t: TrustView): string {
  const made = t.kept + t.broken;
  if (made === 0) return "no promises yet";
  return `${t.kept} of ${made} kept`;
}

/** The whole of it as a sentence, for the seat's accessible name. */
export function trustSentence(t: TrustView): string {
  return `Trust ${trustFigure(t)}, ${trustNote(t)}.`;
}

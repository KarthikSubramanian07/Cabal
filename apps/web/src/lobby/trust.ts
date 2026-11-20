/**
 * The Ledger at the table: each signed-in player's trust score, read from their public record and
 * shown on their seat, so a player weighing an offer knows whose word it is. Players are looked up
 * once per visit; the score only moves when a rated game ends.
 */
import type { TrustView } from "@cabal/protocol";
import { useEffect, useMemo, useState } from "react";
import { api } from "../net/api.js";
import { percent } from "../profile/record.js";

const known = new Map<string, Promise<TrustView | null>>();

/** One player's trust, fetched at most once per visit (a failed look-up is tried again next time). */
export function lookUpTrust(handle: string, fetch: (handle: string) => Promise<TrustView> = (h) => api.profile(h).then((p) => p.trust)): Promise<TrustView | null> {
  const key = handle.toLowerCase();
  let hit = known.get(key);
  if (!hit) {
    hit = fetch(handle).catch(() => {
      known.delete(key);
      return null;
    });
    known.set(key, hit);
  }
  return hit;
}

/** Forget every look-up (tests). */
export function forgetTrust(): void {
  known.clear();
}

/** Trust per handle, lower-cased, for the signed-in players among `handles`. */
export function useTrust(handles: readonly (string | null | undefined)[]): Record<string, TrustView> {
  const list = useMemo(() => [...new Set(handles.filter((h): h is string => Boolean(h)).map((h) => h.toLowerCase()))].sort(), [handles]);
  const key = list.join(" ");
  const [trust, setTrust] = useState<Record<string, TrustView>>({});
  useEffect(() => {
    let live = true;
    for (const handle of key ? key.split(" ") : []) {
      void lookUpTrust(handle).then((t) => {
        if (live && t) setTrust((current) => (current[handle] === t ? current : { ...current, [handle]: t }));
      });
    }
    return () => {
      live = false;
    };
  }, [key]);
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

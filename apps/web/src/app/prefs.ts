/** Small per-device preferences kept in localStorage and shared between screens. */
import { useCallback, useSyncExternalStore } from "react";

const SHORTCUTS_KEY = "cabal.shortcuts";
const listeners = new Set<() => void>();

function readShortcuts(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_KEY) !== "off";
  } catch {
    return true;
  }
}

let shortcuts: boolean | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the single-key shortcuts (M, S, C, H, D) are on. They can be switched off (WCAG 2.1.4). */
export function useShortcuts(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => (shortcuts ??= readShortcuts()),
    () => true,
  );
  const set = useCallback((on: boolean) => {
    shortcuts = on;
    try {
      localStorage.setItem(SHORTCUTS_KEY, on ? "on" : "off");
    } catch {
      // storage can be unavailable (private windows); the choice still holds for this visit
    }
    for (const l of listeners) l();
  }, []);
  return [value, set];
}

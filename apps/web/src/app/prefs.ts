/** Small per-device preferences kept in localStorage and shared between screens. */
import { useCallback, useSyncExternalStore } from "react";

const SHORTCUTS_KEY = "cabal.shortcuts";
const listeners = new Set<() => void>();

/** Unknown until storage has been read. The first touch of localStorage can take the main
 * thread for several milliseconds, so it is kept out of the first render. */
let shortcuts: boolean | undefined;

function read(): boolean {
  if (shortcuts === undefined) {
    try {
      shortcuts = localStorage.getItem(SHORTCUTS_KEY) !== "off";
    } catch {
      shortcuts = true;
    }
  }
  return shortcuts;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (shortcuts === undefined) {
    // Read once the page has settled, then tell whoever is listening if the answer is "off".
    const settle = () => {
      if (!read()) for (const l of listeners) l();
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(settle, { timeout: 1500 });
    else setTimeout(settle, 300);
  }
  return () => listeners.delete(listener);
}

/**
 * Whether the single-key shortcuts (M, S, C, H, D) are on right now, read from storage if
 * need be. For event handlers, which must not act on a default.
 */
export function shortcutsEnabled(): boolean {
  return read();
}

/** The shortcut preference for rendering, and a setter. They can be switched off (WCAG 2.1.4). */
export function useShortcuts(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => shortcuts ?? true,
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

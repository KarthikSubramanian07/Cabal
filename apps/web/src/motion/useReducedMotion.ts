import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

/** Whether the player has asked for less motion, now. For event handlers and timers. */
export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}

function subscribe(listener: () => void): () => void {
  const m = media();
  m?.addEventListener("change", listener);
  return () => m?.removeEventListener("change", listener);
}

/** Whether the player has asked for less motion, kept up to date if they change it. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

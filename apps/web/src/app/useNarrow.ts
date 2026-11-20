import { useSyncExternalStore } from "react";

/** The width at which the sidebar becomes a sheet over the map (responsive.css). */
const QUERY = "(max-width: 1000px)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

function narrowNow(): boolean {
  return media()?.matches ?? false;
}

function subscribe(listener: () => void): () => void {
  const m = media();
  m?.addEventListener("change", listener);
  return () => m?.removeEventListener("change", listener);
}

/** Whether the screen is a phone's, kept up to date as the screen turns or the window is resized. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, narrowNow, () => false);
}

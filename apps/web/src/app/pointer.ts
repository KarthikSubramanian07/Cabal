import { useSyncExternalStore } from "react";

/**
 * The word for pressing on the board: "tap" on a touch screen, "click" with a mouse or trackpad.
 * Read when a hint is drawn, so a laptop with a touch screen follows whatever pointer it has.
 */
export function pressWord(): "tap" | "click" {
  try {
    return globalThis.matchMedia?.("(pointer: coarse)").matches ? "tap" : "click";
  } catch {
    return "click";
  }
}

/** `pressWord` with a capital, to start a sentence. */
export const PressWord = (): "Tap" | "Click" => (pressWord() === "tap" ? "Tap" : "Click");

const COARSE = "(pointer: coarse)";

function subscribe(listener: () => void): () => void {
  let m: MediaQueryList | null = null;
  try {
    m = globalThis.matchMedia?.(COARSE) ?? null;
  } catch {
    m = null;
  }
  m?.addEventListener?.("change", listener);
  return () => m?.removeEventListener?.("change", listener);
}

/**
 * `pressWord` for a component, as `[word, Word]`. The prerendered page and the first render in the
 * browser both say "click", so React can take over the page without a mismatch; a touch screen
 * then switches to "tap" straight away, and the words follow the pointer if it changes.
 */
export function usePressWords(): readonly ["tap" | "click", "Tap" | "Click"] {
  const word = useSyncExternalStore(subscribe, pressWord, () => "click" as const);
  return word === "tap" ? (["tap", "Tap"] as const) : (["click", "Click"] as const);
}

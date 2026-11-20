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

import { afterEach, describe, expect, it, vi } from "vitest";
import { PressWord, pressWord } from "./pointer.js";

const pointer = (coarse: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: coarse && q === "(pointer: coarse)" }));

describe("the word for pressing on the board", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("says tap on a touch screen and click with a mouse", () => {
    pointer(true);
    expect([pressWord(), PressWord()]).toEqual(["tap", "Tap"]);
    pointer(false);
    expect([pressWord(), PressWord()]).toEqual(["click", "Click"]);
  });
  it("says click when the browser cannot tell", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("no media queries");
    });
    expect(pressWord()).toBe("click");
  });
});

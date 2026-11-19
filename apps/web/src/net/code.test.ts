import { describe, expect, it } from "vitest";
import { isGameCode, parseGameCode, spacedCode } from "./code.js";

describe("game codes", () => {
  it("accepts the server's alphabet only", () => {
    expect(isGameCode("K7Q2XZ")).toBe(true);
    // I, O, 0 and 1 are never dealt.
    expect(isGameCode("K7Q2XO")).toBe(false);
    expect(isGameCode("K7Q2X1")).toBe(false);
    expect(isGameCode("K7Q2X")).toBe(false);
    expect(isGameCode("k7q2xz")).toBe(false);
  });

  it("reads a code however it was typed or pasted", () => {
    expect(parseGameCode("k7q2xz")).toBe("K7Q2XZ");
    expect(parseGameCode("  K7Q 2XZ ")).toBe("K7Q2XZ");
    expect(parseGameCode("k7q-2xz")).toBe("K7Q2XZ");
    expect(parseGameCode("https://playcabal.pages.dev/g/K7Q2XZ")).toBe("K7Q2XZ");
    expect(parseGameCode("playcabal.pages.dev/g/k7q2xz?from=share")).toBe("K7Q2XZ");
    expect(parseGameCode("http://localhost:5173/g/K7Q2XZ#seat")).toBe("K7Q2XZ");
  });

  it("finds nothing where there is no code", () => {
    expect(parseGameCode("")).toBeNull();
    expect(parseGameCode("hello")).toBeNull();
    expect(parseGameCode("https://playcabal.pages.dev/games")).toBeNull();
    expect(parseGameCode("https://playcabal.pages.dev/g/K7Q2XZQ")).toBeNull();
  });

  it("spaces a code for reading aloud", () => {
    expect(spacedCode("K7Q2XZ")).toBe("K7Q 2XZ");
    expect(spacedCode("K7")).toBe("K7");
  });
});

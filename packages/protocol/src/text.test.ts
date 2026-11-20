import { describe, expect, it } from "vitest";
import { QUOTE_CHARS, excerpt, graphemes } from "./text.js";

// Characters that are one to a reader and several to JavaScript.
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // man, woman, girl, boy: 11 UTF-16 units
const THUMB = "\u{1F44D}\u{1F3FD}"; // thumbs up, medium skin tone: 4 units, 2 code points
const FLAG = "\u{1F1EB}\u{1F1F7}"; // France: two regional indicators
const E_ACUTE = "é"; // e and a combining acute accent: 2 code points
const ZALGO = "à́̂̃"; // one letter carrying four accents

describe("counting characters as a reader does", () => {
  it("counts an emoji sequence, a flag and a letter with its accents as one character each", () => {
    expect(graphemes(`${FAMILY}${THUMB}${FLAG}${E_ACUTE}${ZALGO}x`)).toEqual([FAMILY, THUMB, FLAG, E_ACUTE, ZALGO, "x"]);
    expect(graphemes("")).toEqual([]);
  });
});

describe("an excerpt", () => {
  it("keeps a text that fits as it is", () => {
    const text = `${FAMILY.repeat(QUOTE_CHARS)}`;
    expect(text.length).toBe(11 * QUOTE_CHARS);
    expect(excerpt(text)).toBe(text);
    expect(excerpt("Peace in the Balkans.")).toBe("Peace in the Balkans.");
  });

  it("is at most 280 characters, ellipsis included, however many units they take", () => {
    for (const unit of [FAMILY, THUMB, FLAG, E_ACUTE, ZALGO, "a"]) {
      const cut = excerpt(unit.repeat(QUOTE_CHARS + 1));
      expect(graphemes(cut)).toHaveLength(QUOTE_CHARS);
      expect(cut).toBe(`${unit.repeat(QUOTE_CHARS - 1)}…`);
    }
  });

  it("never cuts a character in two", () => {
    // 279 letters and then an emoji: cutting by UTF-16 units or code points would split it.
    const text = `${"a".repeat(QUOTE_CHARS - 2)}${FAMILY}${THUMB} and more`;
    const cut = excerpt(text);
    expect(cut).toBe(`${"a".repeat(QUOTE_CHARS - 2)}${FAMILY}…`);
    // An accent is never left without its letter, or carried off without it.
    const accents = excerpt(`${"b".repeat(QUOTE_CHARS - 2)}${E_ACUTE}${E_ACUTE}${E_ACUTE}`);
    expect(accents).toBe(`${"b".repeat(QUOTE_CHARS - 2)}${E_ACUTE}…`);
  });

  it("drops the space before its ellipsis, and takes any limit", () => {
    expect(excerpt("one two three", 5)).toBe("one…");
    expect(excerpt(`${THUMB}${THUMB}${THUMB}`, 2)).toBe(`${THUMB}…`);
  });
});

import { describe, expect, it } from "vitest";
import { NEWS_KEY, newsTarget } from "./DispatchBoard.jsx";

describe("the news key", () => {
  it("is N, a key no other shortcut in the room takes", () => {
    expect(NEWS_KEY).toBe("n");
  });

  it("goes to the newest slip first, then to each older one, and round again", () => {
    // Slips are listed oldest first; focus starts outside them.
    expect(newsTarget(3, -1)).toBe(2);
    expect(newsTarget(3, 2)).toBe(1);
    expect(newsTarget(3, 1)).toBe(0);
    expect(newsTarget(3, 0)).toBe(2);
    expect(newsTarget(1, 0)).toBe(0);
  });

  it("has nowhere to go without slips", () => {
    expect(newsTarget(0, -1)).toBe(-1);
  });
});

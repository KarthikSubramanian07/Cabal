import { describe, expect, it } from "vitest";
import { READ_MS, advance, dwell, playFrom, speedLabel } from "./replay.js";

describe("replay playback", () => {
  it("starts at the first phase from the live one, and where the player is otherwise", () => {
    expect(playFrom(null, 3)).toBe(0);
    expect(playFrom(1, 3)).toBe(1);
    expect(playFrom(5, 3)).toBe(0);
    expect(playFrom(null, 0)).toBeNull();
  });

  it("walks the phases in order and ends on the live phase", () => {
    expect(advance(0, 3)).toBe(1);
    expect(advance(1, 3)).toBe(2);
    expect(advance(2, 3)).toBeNull();
  });

  it("waits for the results to draw, then gives time to read, scaled by speed", () => {
    expect(dwell(1600, 1, false)).toBe(1600 + READ_MS);
    expect(dwell(1600, 2, false)).toBe((1600 + READ_MS) / 2);
    expect(dwell(1600, 0.5, false)).toBe((1600 + READ_MS) * 2);
  });

  it("does not wait for animation that reduced motion turns off", () => {
    expect(dwell(1600, 1, true)).toBe(READ_MS);
  });

  it("names each speed", () => {
    expect(speedLabel(0.5)).toEqual({ short: "½×", long: "Half speed" });
    expect(speedLabel(2).long).toBe("Double speed");
  });
});

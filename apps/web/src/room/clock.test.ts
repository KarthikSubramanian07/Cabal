import { describe, expect, it } from "vitest";
import { clockFace, clockWords, urgency } from "./clock.js";

describe("the phase clock", () => {
  it("reads like a clock face, then in days when it is far off", () => {
    expect(clockFace(0)).toBe("0:00");
    expect(clockFace(9 * 60_000 + 41_000)).toBe("9:41");
    expect(clockFace(59_500)).toBe("1:00");
    expect(clockFace(3_725_000)).toBe("1:02:05");
    expect(clockFace(86_400_000 * 2 + 4 * 3_600_000)).toBe("2 days 4 h");
    expect(clockFace(86_400_000)).toBe("1 day");
  });

  it("grows urgent in the last five minutes and the last one", () => {
    expect(urgency(10 * 60_000)).toBe("calm");
    expect(urgency(4 * 60_000)).toBe("soon");
    expect(urgency(30_000)).toBe("now");
  });

  it("says the time in words", () => {
    expect(clockWords(-1)).toBe("The deadline has passed.");
    expect(clockWords(60_000)).toBe("1 minute left.");
    expect(clockWords(5 * 60_000)).toBe("5 minutes left.");
    expect(clockWords(3 * 3_600_000)).toBe("About 3 hours left.");
  });
});

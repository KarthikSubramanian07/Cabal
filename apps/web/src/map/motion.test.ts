import { describe, expect, it } from "vitest";
import { ACT_MAX_MS, DRAW_MS, STAGGER_MS, STAMP_MS, actOf, resultsTiming } from "./motion.js";

describe("the running order of a phase's results", () => {
  it("inks the units that stood and helped before the moves", () => {
    expect(actOf("A PAR H")).toBe("stand");
    expect(actOf("F BRE S A PAR - PIC")).toBe("stand");
    expect(actOf("F NTH C A LON - NWY")).toBe("stand");
    expect(actOf("A PAR - PIC")).toBe("move");
    expect(actOf("F TRI R ALB")).toBe("move");

    const { marks } = resultsTiming([
      { text: "A PAR - PIC", ok: true },
      { text: "F BRE S A PAR - PIC", ok: true },
      { text: "A MAR H", ok: true },
      { text: "A MUN - BUR", ok: true },
    ]);
    // Supports and holds first, one after the other; the moves once those have mostly drawn.
    expect(marks[1]!.delay).toBe(0);
    expect(marks[2]!.delay).toBe(STAGGER_MS);
    const movesStart = STAGGER_MS + DRAW_MS * 0.6;
    expect(marks[0]!.delay).toBe(movesStart);
    expect(marks[3]!.delay).toBe(movesStart + STAGGER_MS);
  });

  it("stamps a failure once its stroke has drawn, and waits for the last stamp", () => {
    const timing = resultsTiming([
      { text: "A PAR - BUR", ok: false },
      { text: "A MUN - BUR", ok: false },
    ]);
    expect(timing.marks[0]!.stamp).toBe(timing.marks[0]!.delay + DRAW_MS);
    expect(timing.total).toBe(timing.marks[1]!.stamp + STAMP_MS);
    // The standoff those two made lands with the stamps, never before the moves are drawn.
    expect(timing.standoffs).toBeGreaterThanOrEqual(timing.marks[1]!.delay);
    expect(timing.standoffs + STAMP_MS).toBeLessThanOrEqual(timing.total);
  });

  it("squeezes a crowded act instead of letting it drag", () => {
    const many = Array.from({ length: 34 }, () => ({ text: "A PAR - BUR", ok: true }));
    const { marks, total } = resultsTiming(many);
    expect(marks.at(-1)!.delay).toBeLessThanOrEqual(ACT_MAX_MS);
    expect(total).toBeLessThanOrEqual(ACT_MAX_MS + DRAW_MS);
  });

  it("has nothing to time when nothing was ordered", () => {
    expect(resultsTiming([])).toEqual({ marks: [], standoffs: 0, total: 0 });
  });
});

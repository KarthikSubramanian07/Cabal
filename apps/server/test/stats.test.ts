/** The statistics behind the metrics summary and the cold start gate. */
import { describe, expect, it } from "vitest";
import { overBudget, quantile, regressions, summarise } from "../src/stats.js";

describe("quantile", () => {
  it("interpolates between closest ranks, like PERCENTILE.INC", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([15, 20, 35, 40, 50], 0.4)).toBe(29);
    expect(quantile([3, 1, 2], 0)).toBe(1);
    expect(quantile([3, 1, 2], 1)).toBe(3);
    expect(quantile([7], 0.95)).toBe(7);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(quantile(hundred, 0.95)).toBeCloseTo(95.05, 10);
  });

  it("has nothing to say about no samples, and refuses a quantile outside 0 to 1", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(() => quantile([1], 1.5)).toThrow(RangeError);
    expect(() => quantile([1], Number.NaN)).toThrow(RangeError);
  });

  it("never reorders the caller's array", () => {
    const values = [3, 1, 2];
    quantile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("summarise", () => {
  it("reports the usual figures, rounded, ignoring values that are not numbers", () => {
    expect(summarise([10, 20, 30, Number.NaN, Number.POSITIVE_INFINITY])).toEqual({ n: 3, min: 10, median: 20, p90: 28, p95: 29, p99: 29.8, max: 30 });
    expect(summarise([])).toBeNull();
  });
});

describe("the gates", () => {
  const s = (median: number) => summarise([median])!;

  it("flags a median slower than the base by more than the ratio plus the slack", () => {
    const base = { a: s(10), b: s(100), c: s(1) };
    const head = { a: s(20.1), b: s(150), c: s(6) };
    expect(regressions(base, head, ["a", "b", "c"], 1.5, 5)).toEqual([{ metric: "a", base: 10, head: 20.1, limit: 20 }]);
  });

  it("skips a metric the base did not measure", () => {
    expect(regressions({ a: null }, { a: s(1000) }, ["a", "missing"], 1.5, 5)).toEqual([]);
  });

  it("holds medians to their ceilings, and counts a missing measurement as over", () => {
    expect(overBudget({ a: s(10), b: s(60) }, { a: 50, b: 50, c: 10 })).toEqual([
      { metric: "b", median: 60, ceiling: 50 },
      { metric: "c", median: null, ceiling: 10 },
    ]);
  });
});

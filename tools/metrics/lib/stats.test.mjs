import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { percentile, summarise } from "./stats.mjs";

describe("percentile", () => {
  it("is the nearest rank: a value that was measured, never an interpolation", () => {
    const values = [15, 20, 35, 40, 50];
    assert.equal(percentile(values, 0.05), 15);
    assert.equal(percentile(values, 0.3), 20);
    assert.equal(percentile(values, 0.4), 20);
    assert.equal(percentile(values, 0.5), 35);
    assert.equal(percentile(values, 1), 50);
    assert.equal(percentile(values, 0), 15);
  });

  it("sorts its input without changing the caller's array", () => {
    const values = [9, 1, 5];
    assert.equal(percentile(values, 0.5), 5);
    assert.deepEqual(values, [9, 1, 5]);
  });

  it("p95 of a hundred values is the 95th, and of twenty the 19th", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(hundred, 0.95), 95);
    assert.equal(percentile(hundred, 0.99), 99);
    assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95), 19);
  });

  it("ignores what is not a number, is null for nothing, and refuses a fraction outside 0 to 1", () => {
    assert.equal(percentile([NaN, 3, Infinity], 0.5), 3);
    assert.equal(percentile([], 0.5), null);
    assert.throws(() => percentile([1], 95), RangeError);
  });
});

describe("summarise", () => {
  it("counts and rounds to a tenth", () => {
    assert.deepEqual(summarise([10.04, 20.06, 30]), { n: 3, p50: 20.1, p95: 30, p99: 30, min: 10, max: 30 });
    assert.deepEqual(summarise([]), { n: 0, p50: null, p95: null, p99: null, min: null, max: null });
  });
});

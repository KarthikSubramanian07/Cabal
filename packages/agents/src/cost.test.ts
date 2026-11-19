import { describe, expect, it } from "vitest";
import { PRICES, type Usage, ZERO_USAGE, addUsage, costMicros, microsToUsd } from "./cost.js";

const MILLION = 1_000_000;

describe("costMicros", () => {
  it("is zero for zero tokens", () => {
    expect(costMicros("claude-opus-5-5", ZERO_USAGE)).toBe(0);
  });

  it("prices one million tokens of each kind at its published rate per million", () => {
    // Claude Opus 5.5: $4 input, $20 output, $0.20 cache read, $5 cache write (1.25 x input, 5 minute cache).
    const one = (field: keyof Usage) => microsToUsd(costMicros("claude-opus-5-5", { ...ZERO_USAGE, [field]: MILLION }));
    expect(one("inputTokens")).toBe(4);
    expect(one("outputTokens")).toBe(20);
    expect(one("cacheReadTokens")).toBe(0.2);
    expect(one("cacheWriteTokens")).toBe(5);
    expect(PRICES["claude-opus-5-5"]!.cacheWrite).toBe(PRICES["claude-opus-5-5"]!.input * 1.25);
  });

  it("adds every kind of token at its own rate", () => {
    const usage: Usage = { inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 400_000 };
    // 0.2M x $4 + 0.1M x $20 + 1M x $0.20 + 0.4M x $5 = 0.8 + 2 + 0.2 + 2 = $5.00, exactly.
    expect(costMicros("claude-opus-5-5", usage)).toBe(5_000_000);
  });

  it("prices summed usage the same as the sum of the parts", () => {
    const a: Usage = { inputTokens: 900, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0 };
    const b: Usage = { inputTokens: 100, outputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 8000 };
    expect(costMicros("claude-opus-5-5", addUsage(a, b))).toBe(costMicros("claude-opus-5-5", a) + costMicros("claude-opus-5-5", b));
  });
});

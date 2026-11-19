import { describe, expect, it } from "vitest";
import { type ModelPricing, type TokenUsage, estimateCost } from "./cost.js";

const pricing: ModelPricing = {
  inputPerMTok: 10,
  outputPerMTok: 50,
  cacheWritePerMTok: 12.5,
  cacheReadPerMTok: 1,
};

const none: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

describe("estimateCost", () => {
  it("is zero for zero tokens", () => {
    expect(estimateCost(none, pricing)).toBe(0);
  });

  it("prices one million input tokens at the input rate", () => {
    expect(estimateCost({ ...none, inputTokens: 1_000_000 }, pricing)).toBe(10);
  });

  it("adds output, cache write and cache read at their own rates", () => {
    const usage: TokenUsage = {
      inputTokens: 200_000,
      outputTokens: 100_000,
      cacheCreationInputTokens: 400_000,
      cacheReadInputTokens: 1_000_000,
    };
    // 200k * 10 + 100k * 50 + 400k * 12.5 + 1M * 1, per million tokens
    // = 2 + 5 + 5 + 1 = 13 dollars
    expect(estimateCost(usage, pricing)).toBeCloseTo(13, 10);
  });
});
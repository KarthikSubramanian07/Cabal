/**
 * Token and cost accounting for model calls.
 *
 * Money is counted in whole micro-dollars (one millionth of a US dollar) so sums stay exact.
 * Prices are US dollars per million tokens, from the published Claude API price list; a cache
 * write is billed at 1.25 times the input price (five minute lifetime, the only one used here).
 * This file has no dependency on the SDK, so a server can price and cap spend without loading it.
 */

/** What one request used, as reported by the API's `usage` object. */
export interface Usage {
  /** Input tokens billed at the full price (not read from or written to the cache). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** A model missing from the table is priced as the dearest one in it, so a cap can only err safe. */
export function priceOf(model: string): Price {
  return PRICES[model] ?? PRICES["claude-opus-5"]!;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Dollars per million tokens times tokens is exactly micro-dollars. Rounded up: never under-count. */
export function costMicros(model: string, usage: Usage): number {
  const p = priceOf(model);
  return Math.ceil(
    usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite,
  );
}

/**
 * The most one request can cost: every input token written to the cache and the whole output
 * allowance spent. A budget that reserves this before a call can never be overdrawn by it.
 */
export function maxCallCostMicros(model: string, maxInputTokens: number, maxOutputTokens: number): number {
  const p = priceOf(model);
  return Math.ceil(maxInputTokens * Math.max(p.input, p.cacheWrite) + maxOutputTokens * p.output);
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export const microsToUsd = (micros: number): number => micros / 1_000_000;

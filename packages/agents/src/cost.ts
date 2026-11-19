/** Token counts for one model call, as reported by the Messages API. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Dollars per million tokens. Take these from the current Anthropic pricing page, not from memory. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

/** One logged decision: what was asked, what was chosen, and what it cost. */
export interface DecisionRecord {
  phase: string;
  power: string;
  model: string;
  prompt: string;
  orders: string[];
  dropped: { text: string; reason: string }[];
  usage: TokenUsage;
  costUsd: number;
}

/** Cost in US dollars of one call, given its token counts and the model's pricing. */
export function estimateCost(usage: TokenUsage, pricing: ModelPricing): number {
  const dollars = (perMTok: number, tokens: number) => (perMTok * tokens) / 1_000_000;
  return (
    dollars(pricing.inputPerMTok, usage.inputTokens) +
    dollars(pricing.outputPerMTok, usage.outputTokens) +
    dollars(pricing.cacheWritePerMTok, usage.cacheCreationInputTokens) +
    dollars(pricing.cacheReadPerMTok, usage.cacheReadInputTokens)
  );
}
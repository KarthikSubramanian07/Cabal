import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeBrain, type Decision } from "./player.js";

const decision: Decision = {
  reasoning: "hold",
  orders: [],
  messages: [],
  pledge: null,
  relationships: [],
  diary: "quiet",
};

/** Stand-in for the SDK client: returns a canned response with the given usage and stop reason. */
function fakeClient(usage: Record<string, number | null>, stop = "end_turn") {
  return {
    messages: {
      parse: async () => ({ parsed_output: decision, stop_reason: stop, usage }),
    },
  } as unknown as Anthropic;
}

describe("ClaudeBrain.decideWithUsage", () => {
  it("returns the decision and maps usage, treating null cache counts as zero", async () => {
    const brain = new ClaudeBrain({
      client: fakeClient({
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 7,
      }),
    });
    const result = await brain.decideWithUsage("system", "prompt");
    expect(result.decision).toEqual(decision);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 7,
    });
  });

  it("still throws on refusal", async () => {
    const brain = new ClaudeBrain({
      client: fakeClient(
        { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        "refusal",
      ),
    });
    await expect(brain.decide("system", "prompt")).rejects.toThrow(/no decision/);
  });
});
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, mapInfo, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { costMicros } from "./cost.js";
import { type Brain, type Decision, Player } from "./player.js";
import { decisionRecord } from "./record.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

const usage = { inputTokens: 900, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0 };
const answer: Decision = {
  reasoning: "Burgundy first.",
  orders: ["A PAR - BUR", "A MAR - ROM", "F BRE - MAO"],
  messages: [],
  pledge: null,
  relationships: [],
  diary: "West.",
};

async function play(brain: Brain) {
  const game = new Game();
  return new Player("FRANCE", "x", brain).play({
    phase: "S1901M",
    state: game.state(),
    map: mapInfo(),
    legal: game.legal("FRANCE"),
    press: [],
    myPledges: [],
    trust: {},
  });
}

describe("decisionRecord", () => {
  it("logs what was asked, what was submitted, what was dropped and what it cost", async () => {
    const played = await play({ decide: async () => ({ decision: answer, usage, model: "claude-opus-5-5" }) });
    const record = decisionRecord("S1901M", "FRANCE", played);
    expect(record).toMatchObject({
      phase: "S1901M",
      power: "FRANCE",
      step: "order",
      model: "claude-opus-5-5",
      orders: ["A PAR - BUR", "F BRE - MAO"],
      dropped: [{ text: "A MAR - ROM", reason: "not on the legal menu" }],
      fallback: false,
      usage,
    });
    expect(record.prompt).toContain("You are FRANCE");
    expect(record.decision.reasoning).toBe("Burgundy first.");
    // The cost is the one the player worked out, from the shared price table: $0.0101 here.
    expect(record.costMicros).toBe(costMicros("claude-opus-5-5", usage));
    expect(record.costMicros).toBe(900 * 4 + 300 * 20 + 2500 * 0.2);
  });

  it("is plain JSON, so a log line reads back as the same record", async () => {
    const played = await play({ decide: async () => ({ decision: answer, usage, model: "claude-opus-5-5" }) });
    const record = decisionRecord("S1901M", "FRANCE", played);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it("records a failed turn as a free fallback with no usage", async () => {
    const played = await play({ decide: async () => Promise.reject(new Error("down")) });
    const record = decisionRecord("S1901M", "FRANCE", played);
    expect(record).toMatchObject({ fallback: true, model: null, usage: null, costMicros: 0, dropped: [] });
    expect(record.orders.every((o) => o.endsWith(" H"))).toBe(true);
    expect(record).not.toHaveProperty("failure");
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});

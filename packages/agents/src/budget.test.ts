import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, mapInfo, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { BotBrain } from "./bot-brain.js";
import { CappedBrain, FailoverBrain, SpendCap } from "./budget.js";
import { type Usage, costMicros, maxCallCostMicros } from "./cost.js";
import { type Brain, BrainFailure, type BrainReply, type BrainRequest, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, PERSONAS, Player } from "./player.js";
import { decisionRecord } from "./record.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

const MODEL = "claude-haiku-5-5";
const USAGE: Usage = { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 10_000, cacheWriteTokens: 0 };
const WORST_ORDER = maxCallCostMicros(MODEL, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS.movement);

/** A metered brain that holds every unit and reports fixed usage, counting its calls. */
function metered(usage: Usage = USAGE) {
  const calls: BrainRequest[] = [];
  const brain: Brain = {
    async decide(request: BrainRequest): Promise<BrainReply> {
      calls.push(request);
      return { decision: { reasoning: "", orders: [], messages: [], pledge: null, relationships: [], diary: "" }, usage, model: MODEL };
    },
  };
  return { brain, calls };
}

const request: BrainRequest = { system: "s", prompt: "p", kind: "M", step: "order" };

describe("SpendCap and CappedBrain", () => {
  it("charges what the API reported, not the reservation", async () => {
    const cap = new SpendCap(WORST_ORDER * 3);
    const { brain } = metered();
    await new CappedBrain(brain, MODEL, [cap]).decide(request);
    expect(cap.spentMicros()).toBe(costMicros(MODEL, USAGE));
    expect(cap.leftMicros()).toBe(WORST_ORDER * 3 - costMicros(MODEL, USAGE));
  });

  it("charges a bill above its reservation in full and says so, instead of hiding it", () => {
    const cap = new SpendCap(1_000, "run budget");
    expect(cap.reserve(600)).toBe(true);
    cap.settle(600, 900);
    expect(cap.spentMicros()).toBe(900);
    expect(cap.overrunMicros()).toBe(300);
    expect(cap.leftMicros()).toBe(100);
    expect(cap.reserve(101)).toBe(false);
    cap.settle(0, -5);
    expect(cap.spentMicros()).toBe(900);
  });

  it("refuses a call it could not cover in the worst case, before calling the model", async () => {
    const cap = new SpendCap(WORST_ORDER - 1, "seat cap");
    const { brain, calls } = metered();
    const error = await new CappedBrain(brain, MODEL, [cap]).decide(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrainFailure);
    expect((error as BrainFailure).billed).toBe("no");
    expect((error as BrainFailure).message).toMatch(/^seat cap reached/);
    expect(calls).toHaveLength(0);
    expect(cap.spentMicros()).toBe(0);
  });

  it("trips at the spend where the next worst case no longer fits, and never overspends", async () => {
    const perCall = costMicros(MODEL, USAGE);
    const cap = new SpendCap(WORST_ORDER + 4 * perCall);
    const { brain, calls } = metered();
    const capped = new CappedBrain(brain, MODEL, [cap]);
    let refused = 0;
    for (let i = 0; i < 10; i++) await capped.decide(request).catch(() => refused++);
    expect(calls).toHaveLength(5);
    expect(refused).toBe(5);
    expect(cap.spentMicros()).toBe(5 * perCall);
    expect(cap.spentMicros()).toBeLessThanOrEqual(cap.capMicros);
  });

  it("holds every cap it is under: a full run cap stops a seat with money left", async () => {
    const seat = new SpendCap(WORST_ORDER * 10, "seat cap");
    const run = new SpendCap(WORST_ORDER - 1, "run cap");
    const { brain, calls } = metered();
    await expect(new CappedBrain(brain, MODEL, [seat, run]).decide(request)).rejects.toThrow(/^run cap reached/);
    expect(calls).toHaveLength(0);
    // The seat's reservation was handed back when the run cap said no.
    expect(seat.leftMicros()).toBe(WORST_ORDER * 10);
  });

  it("reserves concurrently, so seven seats in parallel cannot overdraw one cap", async () => {
    const run = new SpendCap(WORST_ORDER * 3);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const calls: BrainRequest[] = [];
    const slow: Brain = {
      async decide(r: BrainRequest) {
        calls.push(r);
        await gate;
        return { decision: { reasoning: "", orders: [], messages: [], pledge: null, relationships: [], diary: "" }, usage: USAGE, model: MODEL };
      },
    };
    const capped = new CappedBrain(slow, MODEL, [run]);
    const all = Promise.allSettled(Array.from({ length: 7 }, () => capped.decide(request)));
    open();
    const results = await all;
    expect(calls).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(4);
  });

  it("keeps the whole reservation for a call whose cost is unknown", async () => {
    const cap = new SpendCap(WORST_ORDER * 2);
    const timeout: Brain = {
      async decide() {
        throw new BrainFailure("the model timed out", "unknown", null, MODEL);
      },
    };
    await expect(new CappedBrain(timeout, MODEL, [cap]).decide(request)).rejects.toThrow("timed out");
    expect(cap.spentMicros()).toBe(WORST_ORDER);
  });

  it("charges nothing for a request the API rejected", async () => {
    const cap = new SpendCap(WORST_ORDER * 2);
    const rejected: Brain = {
      async decide() {
        throw new BrainFailure("model request failed: 400", "no", null, MODEL, 400);
      },
    };
    await expect(new CappedBrain(rejected, MODEL, [cap]).decide(request)).rejects.toThrow();
    expect(cap.spentMicros()).toBe(0);
  });

  it("rejects a negative cap", () => {
    expect(() => new SpendCap(-1)).toThrow(RangeError);
  });
});

describe("FailoverBrain", () => {
  it("plays the bot's orders once the cap is reached, says why, and still bills the failed attempt", async () => {
    const game = new Game();
    const legal = game.legal("FRANCE");
    const state = game.state();
    game.free();
    const partial: Usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const truncated: Brain = {
      async decide() {
        throw new BrainFailure("no decision (stop_reason max_tokens)", "yes", partial, MODEL);
      },
    };
    const brain = new FailoverBrain(truncated, new BotBrain({ seed: "F" }));
    const player = new Player("FRANCE", PERSONAS["FRANCE"]!, brain);
    const played = await player.play({ phase: "S1901M", state, map: mapInfo(), legal, press: [], myPledges: [], trust: {} });
    expect(played.fallback).toBe(false);
    expect(played.failover).toBe("no decision (stop_reason max_tokens)");
    expect(played.model).toBe("cabal-bot/standard");
    expect(played.validated.orders).toHaveLength(3);
    expect(played.validated.orders.every((o) => o.endsWith(" H"))).toBe(false);
    expect(played.costMicros).toBe(costMicros(MODEL, partial));
    expect(decisionRecord("S1901M", "FRANCE", played).failover).toMatch(/max_tokens/);
  });

  it("passes the primary's reply through untouched when it answers", async () => {
    const { brain } = metered();
    const reply = await new FailoverBrain(brain, new BotBrain({ seed: 1 })).decide(request);
    expect(reply.model).toBe(MODEL);
    expect(reply.failover).toBeUndefined();
  });
});

describe("a seat over its cap with no stand-in", () => {
  it("holds every unit, calls nothing and costs nothing", async () => {
    const game = new Game();
    const legal = game.legal("FRANCE");
    const state = game.state();
    game.free();
    const { brain, calls } = metered();
    const player = new Player("FRANCE", PERSONAS["FRANCE"]!, new CappedBrain(brain, MODEL, [new SpendCap(0, "seat cap")]));
    const played = await player.play({ phase: "S1901M", state, map: mapInfo(), legal, press: [], myPledges: [], trust: {} });
    expect(calls).toHaveLength(0);
    expect(played.fallback).toBe(true);
    expect(played.validated.orders).toHaveLength(3);
    expect(played.validated.orders.every((o) => o.endsWith(" H"))).toBe(true);
    expect(played.costMicros).toBe(0);
  });
});

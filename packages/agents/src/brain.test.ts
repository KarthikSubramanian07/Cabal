/**
 * The parts of the player that cost money or lose turns when they are wrong: order validation,
 * memory, the request Claude is actually sent, what a reply costs, and the cached prefix.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Game, mapInfo, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { PRICES, costMicros, maxCallCostMicros } from "./cost.js";
import {
  type Brain,
  BrainFailure,
  ClaudeBrain,
  type Decision,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_BYTES,
  MEMORY_LIMITS,
  Player,
  validateOrders,
} from "./player.js";
import { SYSTEM_PROMPT, staticReport, systemPrompt, userPrompt } from "./prompt.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

const decision = (over: Partial<Decision> = {}): Decision => ({
  reasoning: "",
  orders: [],
  messages: [],
  pledge: null,
  relationships: [],
  diary: "",
  ...over,
});

const brainOf = (d: Decision): Brain => ({ decide: async () => ({ decision: d, usage: null, model: null }) });

describe("validateOrders", () => {
  const legal = { "A PAR": ["A PAR H", "A PAR - BUR", "A PAR - PIC"], "F BRE": ["F BRE H", "F BRE - MAO"] };

  it("never lets the repair path submit a second order for a unit", () => {
    // Both spellings are off-menu as written and both repair to an order for A PAR.
    const v = validateOrders({ orders: ["a par -> bur", "A PAR -> PIC", "F BRE - MAO"] }, legal);
    expect(v.orders).toEqual(["A PAR - BUR", "F BRE - MAO"]);
    expect(v.dropped).toEqual([{ text: "A PAR -> PIC", reason: "second order for A PAR" }]);
    // The same when the repaired order comes second.
    expect(validateOrders({ orders: ["A PAR - PIC", "a par -> bur"] }, legal).orders).toEqual(["A PAR - PIC"]);
  });

  it("repairs the spellings models drift into", () => {
    const v = validateOrders({ orders: ["FRANCE: A PAR holds.", "F BRE moves to MAO"] }, legal);
    expect(v).toEqual({ orders: ["A PAR H", "F BRE - MAO"], dropped: [] });
  });

  it("accepts as many adjustments as the allowance, one per province", () => {
    const builds = { by_unit: { "": ["A PAR B", "A MAR B", "F MAR B", "F BRE B", "WAIVE"] }, allowance: 2 };
    expect(validateOrders({ orders: ["A PAR B", "F BRE B"] }, builds)).toEqual({ orders: ["A PAR B", "F BRE B"], dropped: [] });
    // Two builds in one centre, and a third build beyond the allowance.
    const greedy = validateOrders({ orders: ["A MAR B", "F MAR B", "A PAR B", "F BRE B"] }, builds);
    expect(greedy.orders).toEqual(["A MAR B", "A PAR B"]);
    expect(greedy.dropped.map((d) => d.reason)).toEqual(["second order for MAR", "more than the allowance of 2"]);
    // Waiving twice is legal.
    expect(validateOrders({ orders: ["WAIVE", "WAIVE"] }, builds).orders).toEqual(["WAIVE", "WAIVE"]);
    const disbands = { by_unit: { "": ["A PAR D", "F BRE D", "A MAR D"] }, allowance: -2 };
    expect(validateOrders({ orders: ["A PAR D", "A PAR D", "A MAR D", "F BRE D"] }, disbands).orders).toEqual(["A PAR D", "A MAR D"]);
  });
});

describe("Player memory and tolerance", () => {
  const play = (player: Player, phase = "S1901M") => {
    const game = new Game();
    return player.play({ phase, state: game.state(), map: mapInfo(), legal: game.legal(player.power), press: [], myPledges: [], trust: {} });
  };

  it("clamps an out-of-range stance instead of losing the turn", async () => {
    const player = new Player(
      "FRANCE",
      "x",
      brainOf(
        decision({
          orders: ["A PAR - BUR"],
          relationships: [
            { power: "GERMANY", stance: 9, note: "ally" },
            { power: "ENGLAND", stance: -40.6, note: "enemy" },
            { power: "ITALY", stance: Number.NaN, note: "?" },
            { power: "FRANCE", stance: 2, note: "myself" },
          ],
          diary: "Opened east.",
        }),
      ),
    );
    const played = await play(player);
    expect(played.fallback).toBe(false);
    expect(played.validated.orders).toEqual(["A PAR - BUR"]);
    expect(played.decision.relationships.map((r) => r.stance)).toEqual([2, -2, 0, 2]);
    expect(player.memory().relationships).toEqual([
      { power: "GERMANY", stance: 2, note: "ally" },
      { power: "ENGLAND", stance: -2, note: "enemy" },
      { power: "ITALY", stance: 0, note: "?" },
    ]);
  });

  it("carries diary and relationships from one player object to the next", async () => {
    const first = new Player("FRANCE", "x", brainOf(decision({ diary: "Germany lied about Burgundy.", relationships: [{ power: "GERMANY", stance: -2, note: "liar" }] })));
    await play(first);
    const stored = JSON.parse(JSON.stringify(first.memory()));
    const prompts: string[] = [];
    const second = new Player(
      "FRANCE",
      "x",
      {
        decide: async (request) => {
          prompts.push(request.prompt);
          return { decision: decision({ diary: "Still angry." }), usage: null, model: null };
        },
      },
      stored,
    );
    await play(second, "F1901M");
    expect(prompts[0]).toContain("- S1901M: Germany lied about Burgundy.");
    expect(prompts[0]).toContain("GERMANY: -2 liar");
    expect(second.memory().diary).toEqual(["S1901M: Germany lied about Burgundy.", "F1901M: Still angry."]);
  });

  it("bounds what it remembers and survives a corrupt store", async () => {
    const player = new Player("FRANCE", "x", brainOf(decision({ diary: "d".repeat(5000) })), {
      diary: Array.from({ length: 100 }, (_, i) => `entry ${i}`),
      relationships: [{ power: "GERMANY", stance: 77, note: "n".repeat(900) }],
    });
    await play(player);
    const memory = player.memory();
    expect(memory.diary).toHaveLength(MEMORY_LIMITS.diaryEntries);
    expect(memory.diary.at(-1)!.length).toBe(MEMORY_LIMITS.diaryChars);
    expect(memory.relationships[0]).toMatchObject({ stance: 2 });
    expect(memory.relationships[0]!.note.length).toBe(MEMORY_LIMITS.noteChars);
    player.restore({ diary: "nonsense", relationships: [null, 4] } as never);
    expect(player.memory()).toEqual({ diary: [], relationships: [] });
  });

  it("labels the negotiate step in the prompt and the diary", async () => {
    const prompts: string[] = [];
    const steps: string[] = [];
    const player = new Player("FRANCE", "x", {
      decide: async (request) => {
        prompts.push(request.prompt);
        steps.push(`${request.kind}:${request.step}`);
        return { decision: decision({ diary: "Asked Germany." }), usage: null, model: null };
      },
    });
    const game = new Game();
    const base = { phase: "S1901M", state: game.state(), map: mapInfo(), legal: game.legal("FRANCE"), press: [], myPledges: [], trust: {} };
    await player.play({ ...base, step: "negotiate" });
    await player.play({ ...base, step: "order" });
    expect(steps).toEqual(["M:negotiate", "M:order"]);
    expect(prompts[0]).toContain("This is the opening of the phase: negotiate.");
    expect(prompts[1]).toContain("These are your final orders for the phase.");
    expect(player.diary).toEqual(["S1901M (talks): Asked Germany.", "S1901M: Asked Germany."]);
  });
});

describe("the cached prefix", () => {
  it("is the same bytes for every seat and every phase, and far above the smallest cacheable prompt", () => {
    const map = mapInfo();
    const system = systemPrompt(map);
    expect(system).toBe(systemPrompt(mapInfo()));
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
    // 512 tokens is the minimum on Claude Opus 5.5. Even at a generous five characters per token
    // this is several times that, so the cache marker cannot be silently ignored.
    expect(system.length / 5).toBeGreaterThan(512 * 3);
    // Nothing that varies between requests may sit in front of the breakpoint.
    expect(system).not.toMatch(/\d{4}-\d{2}-\d{2}|S19\d\dM|You are (FRANCE|ENGLAND)/);
    const report = staticReport(map);
    expect(report).toContain("- PAR* Paris (land): army: BRE BUR GAS PIC");
    expect(report).toMatch(/- STP\* .*fleet from NC: .*; fleet from SC: /);
    expect(report).toContain("- FRANCE: BRE, MAR, PAR");
    expect(report.match(/^- [A-Z]{3}\*? /gm)).toHaveLength(map.provinces.length);
    // The persona and the board are in the user prompt, after the breakpoint.
    const game = new Game();
    const user = userPrompt({ power: "FRANCE", persona: "A persona.", phase: "S1901M", state: game.state(), map, legal: game.legal("FRANCE"), press: [], diary: [], relationships: [], myPledges: [], trust: {} });
    expect(user).toContain("# Persona\nA persona.");
    expect(new TextEncoder().encode(system + user).byteLength).toBeLessThan(MAX_PROMPT_BYTES / 2);
  });
});

describe("cost", () => {
  it("prices each kind of token and rounds up", () => {
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 3000, cacheWriteTokens: 2000 };
    // 1000*4 + 500*20 + 3000*0.2 + 2000*5 micro-dollars.
    expect(costMicros("claude-opus-5-5", usage)).toBe(4000 + 10_000 + 600 + 10_000);
    expect(costMicros("claude-haiku-5-5", { inputTokens: 1, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 })).toBe(1);
    // An unknown model is priced as the dearest known one.
    expect(costMicros("claude-next", usage)).toBe(costMicros("claude-opus-5", usage));
    expect(PRICES["claude-opus-5-5"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  });

  it("bounds a call from above", () => {
    const worst = maxCallCostMicros("claude-opus-5-5", MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS.movement);
    expect(worst).toBe(MAX_INPUT_TOKENS * 5 + MAX_OUTPUT_TOKENS.movement * 20);
    const real = costMicros("claude-opus-5-5", { inputTokens: 0, outputTokens: MAX_OUTPUT_TOKENS.movement, cacheReadTokens: 0, cacheWriteTokens: MAX_INPUT_TOKENS });
    expect(real).toBeLessThanOrEqual(worst);
  });
});

/** A client whose HTTP layer is a function, so the exact request the SDK sends can be read. */
function claude(reply: (body: Record<string, unknown>) => { status?: number; json: unknown } | Promise<never>, options: { effort?: "high" } = {}) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), headers: new Headers(init?.headers), body });
      const out = await reply(body);
      return new Response(JSON.stringify(out.json), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
    },
  });
  return { brain: new ClaudeBrain({ client, ...options }), requests };
}

const message = (text: string, over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [
    { type: "thinking", thinking: "", signature: "s" },
    { type: "text", text },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 },
  ...over,
});

describe("ClaudeBrain", () => {
  const request = { system: "SYSTEM", prompt: "PROMPT", kind: "M", step: "order" } as const;
  const good = decision({ orders: ["A PAR - BUR"], relationships: [{ power: "GERMANY", stance: 7, note: "n" }], diary: "d" });

  it("sends the request shape the Messages API expects for Claude Opus 5.5", async () => {
    const { brain, requests } = claude(() => ({ json: message(JSON.stringify(good)) }));
    const reply = await brain.decide(request);
    expect(requests).toHaveLength(1);
    const { url, headers, body } = requests[0]!;
    expect(url).toMatch(/\/v1\/messages$/);
    expect(headers.get("anthropic-version")).toBeTruthy();
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: MAX_OUTPUT_TOKENS.movement,
      // One cacheable block holding the whole static prefix.
      system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema" } },
      messages: [{ role: "user", content: "PROMPT" }],
    });
    // Nothing this model rejects: no sampling parameters, no thinking budget, no forced tool, no prefill.
    for (const key of ["temperature", "top_p", "top_k", "tool_choice", "tools", "output_format"]) expect(body).not.toHaveProperty(key);
    expect(JSON.stringify(body)).not.toContain("budget_tokens");
    const schema = (body["output_config"] as { format: { schema: Record<string, unknown> } }).format.schema;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(schema["required"]).toEqual(["reasoning", "orders", "messages", "pledge", "relationships", "diary"]);
    // A range the API cannot enforce must not be in the schema, or one stray value fails the parse.
    expect(JSON.stringify(schema)).not.toMatch(/"minimum"|"maximum"/);
    // An out-of-range stance comes through; the player clamps it.
    expect(reply.decision.relationships[0]!.stance).toBe(7);
    expect(reply.model).toBe("claude-opus-5-5");
    expect(reply.usage).toEqual({ inputTokens: 900, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0 });
  });

  it("spends less effort and a smaller allowance on talks, retreats and builds", async () => {
    const { brain, requests } = claude(() => ({ json: message(JSON.stringify(good)) }));
    await brain.decide({ ...request, step: "negotiate" });
    await brain.decide({ ...request, kind: "R" });
    await brain.decide({ ...request, kind: "A" });
    await brain.decide(request);
    const sent = requests.map((r) => [(r.body["output_config"] as { effort: string }).effort, r.body["max_tokens"]]);
    expect(sent).toEqual([
      ["low", MAX_OUTPUT_TOKENS.negotiate],
      ["low", MAX_OUTPUT_TOKENS.retreat],
      ["low", MAX_OUTPUT_TOKENS.adjustment],
      ["medium", MAX_OUTPUT_TOKENS.movement],
    ]);
    const fixed = claude(() => ({ json: message(JSON.stringify(good)) }), { effort: "high" });
    await fixed.brain.decide({ ...request, kind: "R" });
    expect((fixed.requests[0]!.body["output_config"] as { effort: string }).effort).toBe("high");
  });

  it("reports what a refused, truncated or malformed reply cost", async () => {
    for (const json of [
      message("", { stop_reason: "refusal", content: [] }),
      message('{"reasoning": "cut', { stop_reason: "max_tokens" }),
      message("not json"),
      message(JSON.stringify({ orders: "nope" })),
    ]) {
      const { brain } = claude(() => ({ json }));
      const failure = (await brain.decide(request).catch((e: unknown) => e)) as BrainFailure;
      expect(failure).toBeInstanceOf(BrainFailure);
      expect(failure.billed).toBe("yes");
      expect(failure.usage).toEqual({ inputTokens: 900, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0 });
    }
  });

  it("makes one request for a rejected call, marks it unbilled and carries the status", async () => {
    const { brain, requests } = claude(() => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "bad" } } }));
    const failure = (await brain.decide(request).catch((e: unknown) => e)) as BrainFailure;
    expect(failure).toMatchObject({ billed: "no", status: 400, usage: null });
    expect(requests).toHaveLength(1);
    const overloaded = claude(() => ({ status: 529, json: { type: "error", error: { type: "overloaded_error", message: "busy" } } }));
    expect(await overloaded.brain.decide(request).catch((e: unknown) => e)).toMatchObject({ billed: "unknown", status: 529 });
    expect(overloaded.requests).toHaveLength(1);
  });

  it("refuses to send a prompt longer than the bound its cost cap assumes", async () => {
    const { brain, requests } = claude(() => ({ json: message(JSON.stringify(good)) }));
    const failure = await brain.decide({ ...request, prompt: "x".repeat(MAX_PROMPT_BYTES) }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ billed: "no" });
    // The bound is in bytes, which bound tokens whatever the script: a third as many CJK characters are refused too.
    const dense = await brain.decide({ ...request, prompt: "\u6218".repeat(MAX_PROMPT_BYTES / 3) }).catch((e: unknown) => e);
    expect(dense).toMatchObject({ billed: "no" });
    expect(requests).toHaveLength(0);
    // So the reservation covers the dearest prompt the brain will send, at one token per byte.
    const dearest = costMicros("claude-opus-5-5", { inputTokens: 0, outputTokens: MAX_OUTPUT_TOKENS.movement, cacheReadTokens: 0, cacheWriteTokens: MAX_PROMPT_BYTES });
    expect(maxCallCostMicros("claude-opus-5-5", MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS.movement)).toBeGreaterThanOrEqual(dearest);
  });

  it("surfaces tokens and cost in the played decision, including for a failed turn", async () => {
    const game = new Game();
    const input = { phase: "S1901M", state: game.state(), map: mapInfo(), legal: game.legal("FRANCE"), press: [], myPledges: [], trust: {} };
    const ok = claude(() => ({ json: message(JSON.stringify(good)) }));
    const played = await new Player("FRANCE", "x", ok.brain).play(input);
    expect(played).toMatchObject({ fallback: false, model: "claude-opus-5-5", usage: { inputTokens: 900, cacheReadTokens: 2500 } });
    expect(played.costMicros).toBe(900 * 4 + 300 * 20 + 2500 * 0.2);
    // The system block the player sends is the cached prefix, not the bare instructions.
    expect((ok.requests[0]!.body["system"] as { text: string }[])[0]!.text).toBe(systemPrompt(mapInfo()));
    const refused = claude(() => ({ json: message("", { stop_reason: "refusal", content: [] }) }));
    const failed = await new Player("FRANCE", "x", refused.brain).play(input);
    expect(failed).toMatchObject({ fallback: true, model: "claude-opus-5-5" });
    expect(failed.costMicros).toBe(played.costMicros);
    expect(failed.validated.orders.every((o) => o.endsWith(" H"))).toBe(true);
  });
});

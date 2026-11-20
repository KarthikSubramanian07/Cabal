/**
 * Claude seats: the SeatBrain seam, the queue consumer, the tokenless room RPC, the two-step turn
 * (negotiate, then order) and its time bounds, memory kept in the room, and the spend cap.
 * No test here calls the real API: the consumer's brain is replaced by a scripted one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Brain, type BrainReply, type BrainRequest, BrainFailure, type Decision, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, type Usage, costMicros } from "@cabal/agents";
import { agentRuntime, playTurn } from "../src/agent-consumer.js";
import { botBrain, claudeBrain, seatBrain } from "../src/brain.js";
import { Game, engineReady } from "../src/engine.js";
import type { AgentTurn } from "../src/env.js";
import { CLAUDE_MODEL, reservationMicros } from "../src/room.js";
import { Client, type Seat, create, fireAlarm, inRoom, join, serverEnv, sleep, sql, start, stubOf, summary, until } from "./helpers.js";

// One scripted brain per game. The queue is shared by every test in the run, so a brain is looked
// up by the game a turn belongs to and can never answer for another test's game.
const brains = new Map<string, Brain>();
const realBrain = agentRuntime.makeBrain;
beforeAll(() => {
  agentRuntime.makeBrain = (_env, turn) => brains.get(turn.gameId) ?? null;
});
afterAll(() => {
  agentRuntime.makeBrain = realBrain;
});

const USAGE: Usage = { inputTokens: 900, outputTokens: 400, cacheReadTokens: 2500, cacheWriteTokens: 0 };
const CALL_COST = costMicros(CLAUDE_MODEL, USAGE);
const UNBILLED = { model: null, usage: null, billed: "no" } as const;

interface Script {
  /** Resolves before each call answers. */
  gate?: Promise<void>;
  /** Every call fails this way. */
  fail?: BrainFailure | Error;
  usage?: Usage;
  /** What a seat says when it negotiates. */
  say?: (power: string) => Decision["messages"];
  diary?: (request: BrainRequest) => string;
}

/** A brain that orders every unit to hold, and says what the script tells it to in the talks. */
function scripted(script: Script = {}) {
  const requests: BrainRequest[] = [];
  const brain: Brain = {
    async decide(request: BrainRequest): Promise<BrainReply> {
      requests.push(request);
      await script.gate;
      if (script.fail) throw script.fail;
      const power = /You are ([A-Z]+)\./.exec(request.prompt)![1]!;
      const holds = [...request.prompt.matchAll(/^ {2}([AF] [A-Z]{3}(?:\/[A-Z]{2})? H)$/gm)].map((m) => m[1]!);
      return {
        decision: {
          reasoning: "Hold the line.",
          orders: [...new Set(holds)],
          messages: request.step === "negotiate" ? (script.say?.(power) ?? []) : [],
          pledge: null,
          relationships: [{ power: power === "FRANCE" ? "GERMANY" : "FRANCE", stance: 9, note: "watching" }],
          diary: script.diary?.(request) ?? `${request.step} done`,
        },
        usage: script.usage ?? USAGE,
        model: CLAUDE_MODEL,
      };
    },
  };
  const count = (step?: string) => requests.filter((r) => step === undefined || r.step === step).length;
  return { brain, requests, count };
}

/**
 * A gate the scripted model waits at. The local queue runs few consumers at a time, so a test that
 * leaves one closed starves every later test: `held` always opens it on the way out.
 */
async function held<T>(run: (gate: Promise<void>, open: () => void) => Promise<T>): Promise<T> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  try {
    return await run(gate, open);
  } finally {
    open();
  }
}

/**
 * A Claude game whose turns are queued but never delivered, so a test can play the consumer's part
 * by hand through the same two RPC calls: claim the step, then submit it.
 */
async function undelivered(settings: Record<string, unknown> = {}): Promise<{ ann: Seat; queued: AgentTurn[] }> {
  const queued: AgentTurn[] = [];
  const ann = await create("Ann", { aiFill: true, readyAdvance: true, aiBrain: "claude", ...settings });
  await inRoom(ann.gameId, (room) => {
    room.env = {
      ...room.env,
      ANTHROPIC_API_KEY: "test-key",
      AGENT_QUEUE: { sendBatch: async (messages: { body: AgentTurn }[]) => void queued.push(...messages.map((m) => m.body)) } as never,
    };
  });
  await start(ann);
  return { ann, queued };
}

/** One human and six Claude seats. The room is given a key so it asks the queue for turns. */
async function claudeGame(brain: Brain, settings: Record<string, unknown> = {}, envOver: Record<string, string> = {}): Promise<Seat> {
  const ann = await create("Ann", { aiFill: true, readyAdvance: true, aiBrain: "claude", ...settings });
  brains.set(ann.gameId, brain);
  await inRoom(ann.gameId, (room) => {
    room.env = { ...room.env, ANTHROPIC_API_KEY: "test-key", ...envOver };
  });
  await start(ann);
  return ann;
}

async function seated(ann: Seat): Promise<{ a: Client; units: string[] }> {
  const a = await Client.connect(ann.gameId, ann.token);
  return { a, units: (await a.next("welcome")).p.state.units[ann.power]! };
}

function holdAndReady(a: Client, units: string[], phase: string): void {
  a.send({ t: "orders.set", p: { phase, orders: units.map((u) => `${u} H`) } });
  a.send({ t: "ready", p: { phase, ready: true } });
}

const aiSeats = async (gameId: string) => (await summary(gameId)).seats.filter((s) => s.kind === "ai");
const allReady = async (gameId: string) => (await aiSeats(gameId)).every((s) => s.ready);
const meta = (gameId: string) => inRoom(gameId, (room) => structuredClone(room.meta));
const sources = async (gameId: string, phase: string) =>
  (await sql<{ source: string }>(gameId, "SELECT source FROM orders WHERE phase = ? ORDER BY power", phase)).map((r) => r.source);
const openCalls = (gameId: string) => sql<{ power: string; step: string }>(gameId, "SELECT power, step FROM agent_calls WHERE cost_micros IS NULL");
const step = (gameId: string) => inRoom(gameId, (room) => room.meta.ai?.step ?? null);

describe("SeatBrain", () => {
  it("is the bot unless the game asked for Claude and the server has both a key and a queue", () => {
    const ready = { hasKey: true, hasQueue: true };
    expect(seatBrain({ aiBrain: "bot" }, ready)).toBe(botBrain);
    expect(seatBrain({ aiBrain: "claude" }, ready)).toBe(claudeBrain);
    expect(seatBrain({ aiBrain: "claude" }, { hasKey: false, hasQueue: true })).toBe(botBrain);
    expect(seatBrain({ aiBrain: "claude" }, { hasKey: true, hasQueue: false })).toBe(botBrain);
  });

  it("gives every brain legal orders it can produce at once, inside the room", async () => {
    await engineReady();
    const game = new Game();
    for (const brain of [botBrain, claudeBrain]) {
      const orders = brain.orders(game, "FRANCE", "seed");
      const menu = Object.values(game.legal("FRANCE").by_unit).flat();
      expect(orders).toHaveLength(3);
      expect(orders.every((o) => menu.includes(o))).toBe(true);
      // Deterministic for a seed: a replay and a retry see the same orders.
      expect(brain.orders(game, "FRANCE", "seed")).toEqual(orders);
    }
    expect([botBrain.deliberates, claudeBrain.deliberates]).toEqual([false, true]);
  });
});

describe("Claude seats", () => {
  it("plays every AI seat with the bot when the game did not ask for Claude, without touching the queue", async () => {
    const { brain, count } = scripted();
    const ann = await create("Ann", { aiFill: true });
    brains.set(ann.gameId, brain);
    await inRoom(ann.gameId, (room) => {
      room.env = { ...room.env, ANTHROPIC_API_KEY: "test-key" };
    });
    await start(ann);
    expect(await allReady(ann.gameId)).toBe(true);
    expect(await sources(ann.gameId, "S1901M")).toEqual(Array(6).fill("bot"));
    await sleep(300);
    expect(count()).toBe(0);
    expect(await meta(ann.gameId)).toMatchObject({ claudeTurns: 0, claudeCalls: 0, claudeSpentMicros: 0, ai: null });
    expect((await summary(ann.gameId)).ai).toMatchObject({ brain: "bot", model: null, spentUsd: 0 });
  });

  it("falls back to the bot when Claude was asked for but no key is configured", async () => {
    const ann = await create("Ann", { aiFill: true, aiBrain: "claude" });
    await start(ann);
    expect(await allReady(ann.gameId)).toBe(true);
    expect(await meta(ann.gameId)).toMatchObject({ aiDueAt: null, ai: null, claudeTurns: 0 });
    expect(await sql(ann.gameId, "SELECT * FROM agent_calls")).toHaveLength(0);
  });

  it("negotiates, listens, then orders: every seat reads the phase's press before it decides", async () => {
    const { brain, requests, count } = scripted({ say: (power) => [{ to: "ALL", body: `${power} wants peace` }] });
    const ann = await claudeGame(brain);
    const { a, units } = await seated(ann);
    // Six seats talk. Nobody has ordered and the bot's orders are on file underneath.
    await until(async () => (await step(ann.gameId)) === "listen", "the talks to finish", 20_000);
    expect(count("negotiate")).toBe(6);
    expect(count("order")).toBe(0);
    expect(await sources(ann.gameId, "S1901M")).toEqual(Array(6).fill("bot"));
    expect(await allReady(ann.gameId)).toBe(false);
    // The room now listens for at most two minutes, far inside the two-day phase.
    const listening = await meta(ann.gameId);
    expect(listening.aiDueAt).toBe(listening.ai!.listenUntil);
    expect(listening.aiDueAt! - Date.now()).toBeGreaterThan(60_000);
    expect(listening.aiDueAt! - Date.now()).toBeLessThanOrEqual(120_000);
    // The human answers one of them and readies: the table has stopped talking.
    const ai = (await aiSeats(ann.gameId))[0]!.power;
    a.send({ t: "press.send", p: { to: ai, body: "Ann offers a border truce" } });
    await a.next("press", (m) => m.p.from === ann.power);
    holdAndReady(a, units, "S1901M");
    const results = await a.next("results", () => true, 20_000);
    expect(results.p.results.every((r) => r.order.endsWith(" H"))).toBe(true);
    expect(count("order")).toBe(6);
    expect((await sources(ann.gameId, "S1901M")).sort()).toEqual([...Array(6).fill("claude"), "human"]);
    // The fix for the decide-instantly bug: the order step has read what the others said.
    const order = requests.find((r) => r.step === "order" && r.prompt.includes(`You are ${ai}.`))!;
    expect(order.prompt).toContain(`${ann.power} -> ${ai}: "Ann offers a border truce"`);
    const other = (await aiSeats(ann.gameId))[1]!.power;
    expect(order.prompt).toContain(`${other} -> ALL: "${other} wants peace"`);
    expect(order.prompt).toContain("These are your final orders for the phase.");
    // A different seat never sees the private message.
    const stranger = requests.find((r) => r.step === "order" && r.prompt.includes(`You are ${other}.`))!;
    expect(stranger.prompt).not.toContain("border truce");
    // Their press is ordinary press: one message each, from their own seat.
    const press = await sql<{ sender: string; recipient: string }>(ann.gameId, "SELECT sender, recipient FROM press WHERE sender <> ?", ann.power);
    expect(press).toHaveLength(6);
    // Twelve calls, each settled from its usage report.
    const calls = await sql<{ step: string; outcome: string; model: string; cost_micros: number; input_tokens: number; output_tokens: number; cache_read_tokens: number }>(
      ann.gameId,
      "SELECT step, outcome, model, cost_micros, input_tokens, output_tokens, cache_read_tokens FROM agent_calls WHERE phase = 'S1901M'",
    );
    expect(calls).toHaveLength(12);
    expect(calls.filter((c) => c.step === "negotiate")).toHaveLength(6);
    for (const call of calls) {
      expect(call).toMatchObject({ outcome: "answered", model: CLAUDE_MODEL, cost_micros: CALL_COST, input_tokens: 900, output_tokens: 400, cache_read_tokens: 2500 });
    }
    // The bill is public, and it is the sum of what the calls reported (the next phase has begun,
    // so more may have been added by now).
    const bill = (await summary(ann.gameId)).ai;
    expect(bill).toMatchObject({ brain: "claude", model: CLAUDE_MODEL, capUsd: 5, stopped: null });
    expect(bill.spentUsd).toBeGreaterThanOrEqual((12 * CALL_COST) / 1e6);
    expect(bill.spentUsd * 1e6).toBe((await meta(ann.gameId)).claudeSpentMicros);
    expect(bill.tokens.cacheReadTokens).toBeGreaterThanOrEqual(12 * 2500);
    expect(bill.spentUsd).toBeLessThan(bill.capUsd);
    // The next phase has opened, and nothing from the old one is left unsettled.
    expect((await summary(ann.gameId)).phase).toBe("F1901M");
    expect(await sql(ann.gameId, "SELECT 1 FROM agent_calls WHERE phase = 'S1901M' AND cost_micros IS NULL")).toHaveLength(0);
  }, 60_000);

  it("skips the talks in a gunboat game, in retreat and adjustment phases and when the phase is too short", async () => {
    const gunboat = scripted();
    const g = await claudeGame(gunboat.brain, { press: "gunboat" });
    await until(() => allReady(g.gameId), "the gunboat seats to order", 20_000);
    expect([gunboat.count("negotiate"), gunboat.count("order")]).toEqual([0, 6]);
    expect(await sources(g.gameId, "S1901M")).toEqual(Array(6).fill("claude"));

    const quick = scripted();
    const q = await claudeGame(quick.brain, { movementSeconds: 180 });
    await until(() => allReady(q.gameId), "the quick seats to order", 20_000);
    expect([quick.count("negotiate"), quick.count("order")]).toEqual([0, 6]);
    expect((await meta(q.gameId)).claudeCalls).toBe(6);
  }, 60_000);

  it("H1: a human cannot resolve a phase while Claude seats are still thinking", async () => {
    await held(async (gate, open) => {
    const { brain } = scripted({ gate });
    const ann = await claudeGame(brain);
    const { a, units } = await seated(ann);
    expect(await allReady(ann.gameId)).toBe(false);
    // The bot's orders are already on file, so nothing can be lost while the model thinks.
    expect(await sources(ann.gameId, "S1901M")).toEqual(Array(6).fill("bot"));
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    for (let i = 0; i < 10; i++) a.send({ t: "ready", p: { phase: "S1901M", ready: i % 2 === 0 } });
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await sleep(400);
    expect((await summary(ann.gameId)).phase).toBe("S1901M");
    expect((await sql<{ n: number }>(ann.gameId, "SELECT COUNT(*) AS n FROM phases"))[0]!.n).toBe(0);
    expect(await step(ann.gameId)).toBe("negotiate");
    // The seats finish talking. The human is already ready, so they order at once and the phase
    // resolves with nobody readying again.
    open();
    expect((await a.next("state", (m) => m.p.phase === "F1901M", 30_000)).p.phase).toBe("F1901M");
    });
  }, 60_000);

  it("never lets a slow Claude seat hold a phase: each step has a limit, and then the bot's orders stand", async () => {
    await held(async (gate, open) => {
      // The model does not answer until the phase is over.
      const { brain, count } = scripted({ gate });
      const ann = await claudeGame(brain);
      const { a, units } = await seated(ann);
      await until(async () => count("negotiate") > 0, "the talks to start", 20_000);
      // Talks are due within a minute, and the alarm is set for that, not the two-day deadline.
      const talks = await meta(ann.gameId);
      expect(talks.ai?.step).toBe("negotiate");
      expect(talks.aiDueAt! - Date.now()).toBeGreaterThan(30_000);
      expect(talks.aiDueAt! - Date.now()).toBeLessThanOrEqual(60_000);
      expect(await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm())).toBe(talks.aiDueAt);
      holdAndReady(a, units, "S1901M");
      await sleep(100);
      expect((await summary(ann.gameId)).phase).toBe("S1901M");
      // The limit passes: the room stops waiting for talk and asks for orders.
      await inRoom(ann.gameId, (room) => {
        room.meta.aiDueAt = Date.now() - 1;
      });
      await fireAlarm(ann.gameId);
      const ordering = await meta(ann.gameId);
      expect(ordering.ai?.step).toBe("order");
      expect(ordering.aiDueAt! - Date.now()).toBeGreaterThan(60_000);
      expect(ordering.aiDueAt! - Date.now()).toBeLessThanOrEqual(90_000);
      expect((await summary(ann.gameId)).phase).toBe("S1901M");
      expect(await allReady(ann.gameId)).toBe(false);
      // That limit passes too: the phase resolves on the orders already on file.
      await inRoom(ann.gameId, (room) => {
        room.meta.aiDueAt = Date.now() - 1;
      });
      await fireAlarm(ann.gameId);
      const results = await a.next("results");
      expect(results.p.phase).toBe("S1901M");
      // The AI seats were not left holding: their bot orders were adjudicated.
      expect(results.p.results.filter((r) => r.power !== ann.power && !r.order.endsWith(" H")).length).toBeGreaterThan(0);
      // The late answers arrive for a phase that is over. They change nothing, and the calls that
      // were really made are still paid for; turns that never reached the model cost nothing.
      open();
      await until(async () => (await sql(ann.gameId, "SELECT 1 FROM agent_calls WHERE phase = 'S1901M' AND cost_micros IS NULL")).length === 0, "late calls to settle", 30_000);
      expect((await sources(ann.gameId, "S1901M")).sort()).toEqual([...Array(6).fill("bot"), "human"]);
      const made = count();
      expect(made).toBeGreaterThan(0);
      expect((await sql<{ n: number }>(ann.gameId, "SELECT SUM(cost_micros) AS n FROM agent_calls WHERE phase = 'S1901M'"))[0]!.n).toBe(made * CALL_COST);
      expect((await meta(ann.gameId)).claudeSpentMicros).toBe(made * CALL_COST);
    });
  }, 90_000);

  it("stops asking a failing model after one round: each call is made once, never retried", async () => {
    const { brain, count } = scripted({ fail: new BrainFailure("overloaded", "unknown", null, CLAUDE_MODEL, 529) });
    const ann = await claudeGame(brain);
    await until(() => allReady(ann.gameId), "the seats to be released", 20_000);
    await sleep(300);
    // Six talks failed. That is a full round, so no orders were asked for and the bot plays on.
    expect(count()).toBe(6);
    expect(await sources(ann.gameId, "S1901M")).toEqual(Array(6).fill("bot"));
    const failed = await meta(ann.gameId);
    expect(failed).toMatchObject({ claudeOff: "model_failing", claudeStrikes: 6, ai: null, aiDueAt: null });
    // A failure whose bill is unknown is charged in full, so the cap can only err on the safe side.
    expect(failed.claudeSpentMicros).toBe(6 * reservationMicros("M", "negotiate"));
    expect((await summary(ann.gameId)).ai).toMatchObject({ brain: "bot", stopped: "model_failing" });
    const { a, units } = await seated(ann);
    holdAndReady(a, units, "S1901M");
    await a.next("state", (m) => m.p.phase === "F1901M");
    expect(await allReady(ann.gameId)).toBe(true);
    await sleep(300);
    expect(count()).toBe(6);
  }, 60_000);

  it("stops at the first 401: a rejected key is not tried again for every seat and phase", async () => {
    const { brain, count } = scripted({ fail: new BrainFailure("invalid x-api-key", "no", null, CLAUDE_MODEL, 401) });
    const ann = await claudeGame(brain);
    await until(() => allReady(ann.gameId), "the seats to be released", 20_000);
    await sleep(1500);
    const after = await meta(ann.gameId);
    expect(after).toMatchObject({ claudeOff: "model_unauthorised", claudeSpentMicros: 0 });
    // Turns still on the queue when the first 401 came back are dropped unplayed. How many had
    // already started depends on how many consumers were running, so only the bounds are fixed.
    expect(count()).toBeLessThanOrEqual(6);
    expect(count()).toBeGreaterThan(0);
    expect(await openCalls(ann.gameId)).toHaveLength(0);
    expect(await sources(ann.gameId, "S1901M")).toEqual(Array(6).fill("bot"));
  }, 60_000);

  it("A5: refuses a step for a phase that has resolved, and never calls the model for it", async () => {
    const { brain, count } = scripted();
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    brains.set(ann.gameId, brain);
    await start(ann);
    const ai = (await aiSeats(ann.gameId))[0]!.power as "FRANCE";
    const { a, units } = await seated(ann);
    holdAndReady(a, units, "S1901M");
    await a.next("state", (m) => m.p.phase === "F1901M");
    const room = stubOf(ann.gameId);
    expect(await room.agentBrief(ai, "S1901M", "order")).toBeNull();
    expect(await room.agentSubmit(ai, "S1901M", "order", { orders: [], messages: [], pledge: null }, UNBILLED)).toMatchObject({ applied: false, reason: "stale_phase" });
    expect(await playTurn({ gameId: ann.gameId, power: ai, phase: "S1901M", step: "order" }, serverEnv)).toBe("stale");
    // Nor can a turn be conjured for the current phase: the room hands out only what it asked for.
    expect(await room.agentBrief(ai, "F1901M", "order")).toBeNull();
    expect(await playTurn({ gameId: ann.gameId, power: ai, phase: "F1901M", step: "negotiate" }, serverEnv)).toBe("stale");
    expect(count()).toBe(0);
    // A human seat can never be driven through the agent RPC.
    expect(await room.agentBrief(ann.power as "FRANCE", "F1901M", "order")).toBeNull();
    expect(await room.agentSubmit(ann.power as "FRANCE", "F1901M", "order", { orders: [], messages: [], pledge: null }, UNBILLED)).toMatchObject({
      applied: false,
      reason: "not_an_ai_seat",
    });
  });

  it("hands a step out once: a queue message delivered twice is one model call", async () => {
    await held(async (gate, open) => {
      const { brain, requests, count } = scripted({ gate });
      const ann = await claudeGame(brain);
      await until(async () => count("negotiate") > 0, "the talks to start", 20_000);
      const ai = /You are ([A-Z]+)\./.exec(requests[0]!.prompt)![1]!;
      const turn = { gameId: ann.gameId, power: ai, phase: "S1901M", step: "negotiate" } as const;
      const before = count();
      // The same message arrives again while the first delivery is still with the model.
      expect(await playTurn(turn, serverEnv)).toBe("stale");
      expect(await stubOf(ann.gameId).agentBrief(ai as "FRANCE", "S1901M", "negotiate")).toBeNull();
      expect(count()).toBe(before);
      // And again after it has answered.
      open();
      await until(async () => (await step(ann.gameId)) === "listen", "the talks to finish", 30_000);
      expect(await playTurn(turn, serverEnv)).toBe("stale");
      expect(count()).toBe(6);
      expect((await meta(ann.gameId)).claudeSpentMicros).toBe(6 * CALL_COST);
    });
  }, 90_000);

  it("reports each part of a submission on its own, so one bad part never discards the rest", async () => {
    const { ann, queued } = await undelivered();
    const { a, units } = await seated(ann);
    await until(async () => queued.length === 6, "the talks to be queued");
    const seats = (await aiSeats(ann.gameId)).map((s) => s.power as "FRANCE");
    const [ai, peer] = seats as ["FRANCE", "FRANCE"];
    const mine = await inRoom(ann.gameId, (room) => (room as unknown as { game: Game }).game.state().units[ai]!);
    const theirs = await inRoom(ann.gameId, (room) => (room as unknown as { game: Game }).game.state().units[peer]!);
    const room = stubOf(ann.gameId);
    // Claim every step the way the consumer does, then answer it.
    for (const power of seats) expect(await room.agentBrief(power, "S1901M", "negotiate")).toMatchObject({ power, step: "negotiate" });
    const report = { model: CLAUDE_MODEL, usage: USAGE, billed: "yes" } as const;
    const talks = await room.agentSubmit(
      ai,
      "S1901M",
      "negotiate",
      {
        orders: [],
        messages: [
          { to: "ALL", body: "A fair offer to all." },
          { to: "NOWHERE", body: "lost" },
          { to: peer, body: "x".repeat(5000) },
          { to: ai, body: "to myself" },
        ],
        // A pledge about somebody else's unit: refused, but its message is still delivered.
        pledge: { to: "ALL", orders: [`${theirs[0]} H`], sealed: false },
      },
      report,
    );
    expect(talks).toMatchObject({
      applied: true,
      reason: "ok",
      pledge: "dropped",
      messages: [
        { to: "ALL", sent: true, code: null },
        { to: "NOWHERE", sent: false, code: "bad_message" },
        { to: peer, sent: true, code: null },
      ],
    });
    // At most three messages a step, and a long body is cut, never refused.
    const sent = await sql<{ recipient: string; body: string; pledge_id: string | null }>(ann.gameId, "SELECT recipient, body, pledge_id FROM press WHERE sender = ? ORDER BY sent_at, rowid", ai);
    expect(sent.map((m) => [m.recipient, m.body.length, m.pledge_id])).toEqual([
      ["ALL", 20, null],
      [peer, 1000, null],
    ]);
    // The other five say nothing; the human readies; orders are asked for.
    for (const power of seats.slice(1)) await room.agentSubmit(power, "S1901M", "negotiate", null, UNBILLED);
    holdAndReady(a, units, "S1901M");
    await until(async () => (await step(ann.gameId)) === "order", "the order step", 20_000);
    expect(queued.filter((t) => t.step === "order")).toHaveLength(6);
    const brief = (await room.agentBrief(ai, "S1901M", "order"))!;
    // The order brief carries what was said in the talks, the seat's own message included.
    expect(brief.press.map((m) => m.body)).toContain("A fair offer to all.");
    const orders = await room.agentSubmit(
      ai,
      "S1901M",
      "order",
      {
        orders: [`${mine[0]} H`, "A XXX - YYY", `${mine[1]} H`],
        messages: [{ to: peer, body: "I hold, as promised." }],
        pledge: { to: peer, orders: [`${mine[0]} H`, `${theirs[0]} H`], sealed: true },
      },
      report,
    );
    expect(orders.reason).toBe("ok");
    expect(orders.orders.accepted).toEqual([`${mine[0]} H`, `${mine[1]} H`]);
    expect(orders.orders.rejected.map((r) => r.text)).toEqual(["A XXX - YYY"]);
    // Only the pledged orders that were actually submitted are pledged.
    expect(orders).toMatchObject({ applied: true, pledge: "sent", messages: [{ to: peer, sent: true, code: null }] });
    const pledge = await sql<{ orders_json: string; sealed: number }>(ann.gameId, "SELECT orders_json, sealed FROM pledges WHERE pledger = ?", ai);
    expect(pledge).toEqual([{ orders_json: JSON.stringify([`${mine[0]} H`]), sealed: 1 }]);
    expect((await sql<{ source: string }>(ann.gameId, "SELECT source FROM orders WHERE phase = 'S1901M' AND power = ?", ai))[0]!.source).toBe("claude");
    // The seat is closed: a second answer changes nothing and is not billed twice.
    expect(await room.agentSubmit(ai, "S1901M", "order", { orders: [], messages: [], pledge: null }, report)).toMatchObject({ reason: "turn_already_closed" });
    expect((await meta(ann.gameId)).claudeSpentMicros).toBe(2 * CALL_COST);
  }, 60_000);

  it("keeps each seat's diary and relationships in the room, across phases and across evictions", async () => {
    const { brain, requests } = scripted({ diary: (r) => `${/Phase (\S+)\./.exec(r.prompt)![1]} ${r.step}` });
    const ann = await claudeGame(brain, { press: "gunboat" });
    const { a, units } = await seated(ann);
    await until(() => allReady(ann.gameId), "the first orders", 20_000);
    const stored = await sql<{ power: string; memory_json: string }>(ann.gameId, "SELECT power, memory_json FROM agent_memory ORDER BY power");
    expect(stored).toHaveLength(6);
    const first = JSON.parse(stored.find((m) => m.power !== "FRANCE")!.memory_json) as { diary: string[]; relationships: { power: string; stance: number }[] };
    expect(first.diary).toEqual(["S1901M: S1901M order"]);
    // The out-of-range stance the model gave was clamped, not thrown.
    expect(first.relationships).toEqual([{ power: "FRANCE", stance: 2, note: "watching" }]);
    holdAndReady(a, units, "S1901M");
    await a.next("state", (m) => m.p.phase === "F1901M", 20_000);
    await until(() => allReady(ann.gameId), "the second orders", 20_000);
    // A fresh Player was built for the new turn, and it remembered.
    const second = requests.filter((r) => r.prompt.includes("Phase F1901M."));
    expect(second).toHaveLength(6);
    for (const request of second) {
      expect(request.prompt).toContain("# Your diary\n- S1901M: S1901M order");
      expect(request.prompt).toMatch(/# Your relationships\n(FRANCE|GERMANY): \+2 watching/);
    }
    const later = JSON.parse((await sql<{ memory_json: string }>(ann.gameId, "SELECT memory_json FROM agent_memory LIMIT 1"))[0]!.memory_json) as { diary: string[] };
    expect(later.diary).toEqual(["S1901M: S1901M order", "F1901M: F1901M order"]);
  }, 60_000);

  it("stops asking Claude once the game has spent its turn budget", async () => {
    const { brain, count } = scripted();
    const ann = await claudeGame(brain, { press: "gunboat" }, { CLAUDE_TURNS_PER_GAME: "4" });
    await until(() => allReady(ann.gameId), "all AI seats to be ready", 20_000);
    expect((await meta(ann.gameId)).claudeTurns).toBe(4);
    expect(count()).toBe(4);
    expect((await sources(ann.gameId, "S1901M")).sort()).toEqual(["bot", "bot", "claude", "claude", "claude", "claude"]);
    const { a, units } = await seated(ann);
    holdAndReady(a, units, "S1901M");
    await a.next("state", (m) => m.p.phase === "F1901M");
    // The budget is spent: the next phase is all bot, ready at once, with no further model calls.
    expect(await allReady(ann.gameId)).toBe(true);
    expect(await sources(ann.gameId, "F1901M")).toEqual(Array(6).fill("bot"));
    await sleep(300);
    expect(count()).toBe(4);
  }, 60_000);

  it("holds a hard spend cap: the worst case is reserved before a call and the real cost settled after", async () => {
    const turn = reservationMicros("M", "order");
    expect(turn).toBe(MAX_INPUT_TOKENS * 5 + MAX_OUTPUT_TOKENS.movement * 20);
    // Every call costs exactly its worst case, and the cap covers two and a half of them.
    const worst: Usage = { inputTokens: 0, outputTokens: MAX_OUTPUT_TOKENS.movement, cacheReadTokens: 0, cacheWriteTokens: MAX_INPUT_TOKENS };
    expect(costMicros(CLAUDE_MODEL, worst)).toBe(turn);
    const cap = (turn * 2.5) / 1e6;
    const { brain, count } = scripted({ usage: worst });
    const ann = await claudeGame(brain, { press: "gunboat" }, { CLAUDE_USD_PER_GAME: String(cap) });
    // Only two seats could be reserved, although six wanted a turn.
    await until(() => allReady(ann.gameId), "all AI seats to be ready", 20_000);
    expect(count()).toBe(2);
    expect((await sources(ann.gameId, "S1901M")).sort()).toEqual(["bot", "bot", "bot", "bot", "claude", "claude"]);
    const spent = await meta(ann.gameId);
    expect(spent.claudeSpentMicros).toBe(2 * turn);
    expect(spent.claudeSpentMicros).toBeLessThanOrEqual(cap * 1e6);
    // What is left cannot cover another call, so the game is done with Claude and says so.
    const { a, units } = await seated(ann);
    holdAndReady(a, units, "S1901M");
    await a.next("state", (m) => m.p.phase === "F1901M");
    expect(await allReady(ann.gameId)).toBe(true);
    await sleep(300);
    expect(count()).toBe(2);
    expect(await meta(ann.gameId)).toMatchObject({ claudeOff: "spend_cap", claudeSpentMicros: 2 * turn });
    expect((await summary(ann.gameId)).ai).toMatchObject({ brain: "bot", stopped: "spend_cap", spentUsd: (2 * turn) / 1e6, capUsd: cap });
  }, 60_000);

  it("releases a reservation that cost less than its worst case, so cheap calls stretch the budget", async () => {
    // Room for exactly one worst-case turn at a time; each real call costs a fraction of that.
    const cap = (reservationMicros("M", "order") * 1.5) / 1e6;
    const { brain, count } = scripted();
    const ann = await claudeGame(brain, { press: "gunboat" }, { CLAUDE_USD_PER_GAME: String(cap) });
    await until(() => allReady(ann.gameId), "all AI seats to be ready", 20_000);
    expect(count()).toBe(1);
    const { a, units } = await seated(ann);
    holdAndReady(a, units, "S1901M");
    await a.next("state", (m) => m.p.phase === "F1901M");
    await until(() => allReady(ann.gameId), "the next phase's seats", 20_000);
    // The first call settled at its real price, so the next phase could afford one again.
    expect(count()).toBe(2);
    expect(await meta(ann.gameId)).toMatchObject({ claudeSpentMicros: 2 * CALL_COST, claudeOff: null });
  }, 60_000);

  it("spends nothing on a game that sets the cap to zero", async () => {
    const { brain, count } = scripted();
    const ann = await claudeGame(brain, {}, { CLAUDE_USD_PER_GAME: "0" });
    expect(await allReady(ann.gameId)).toBe(true);
    await sleep(300);
    expect(count()).toBe(0);
    expect(await meta(ann.gameId)).toMatchObject({ claudeOff: "spend_cap", claudeSpentMicros: 0, claudeCalls: 0 });
  });

  it("charges a call that never reported its whole reservation, and one that was never picked up nothing", async () => {
    const { ann, queued } = await undelivered({ press: "gunboat" });
    const { a, units } = await seated(ann);
    await until(async () => queued.length === 6, "the turns to be queued");
    // Five calls are claimed, go to the model and are never heard from again; one is never delivered.
    const seats = (await aiSeats(ann.gameId)).map((s) => s.power as "FRANCE");
    const lost = seats[0]!;
    for (const power of seats.slice(1)) expect(await stubOf(ann.gameId).agentBrief(power, "S1901M", "order")).not.toBeNull();
    // While they are out, their worst case is held against the cap.
    expect(await openCalls(ann.gameId)).toHaveLength(6);
    await sql(ann.gameId, "UPDATE agent_calls SET dispatched_at = dispatched_at - 600000");
    holdAndReady(a, units, "S1901M");
    await inRoom(ann.gameId, (room) => {
      room.meta.aiDueAt = Date.now() - 1;
    });
    await fireAlarm(ann.gameId);
    await a.next("state", (m) => m.p.phase === "F1901M");
    const calls = await sql<{ power: string; outcome: string; cost_micros: number }>(ann.gameId, "SELECT power, outcome, cost_micros FROM agent_calls WHERE phase = 'S1901M' ORDER BY power");
    expect(calls.filter((c) => c.outcome === "unreported")).toHaveLength(5);
    expect(calls.find((c) => c.power === lost)).toMatchObject({ outcome: "undelivered", cost_micros: 0 });
    expect((await meta(ann.gameId)).claudeSpentMicros).toBe(5 * reservationMicros("M", "order"));
    // The message that was never delivered turns up at last: there is nothing left for it to claim.
    expect(await stubOf(ann.gameId).agentBrief(lost, "S1901M", "order")).toBeNull();
  }, 60_000);

  it("C2: a queue that rejects the turns neither fails the start nor strands the AI seats", async () => {
    const ann = await create("Ann", { aiFill: true, aiBrain: "claude" });
    await inRoom(ann.gameId, (room) => {
      room.env = {
        ...room.env,
        ANTHROPIC_API_KEY: "test-key",
        AGENT_QUEUE: { sendBatch: async () => Promise.reject(new Error("queue down")) } as never,
      };
    });
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    expect((await start(ann)).status).toBe(200);
    expect((await a.next("state")).p).toMatchObject({ phase: "S1901M", status: "active" });
    await until(() => allReady(ann.gameId), "the AI seats to be released");
    expect(await meta(ann.gameId)).toMatchObject({ aiDueAt: null, ai: null, claudeSpentMicros: 0 });
    // Nothing was delivered, so nothing stays reserved against the cap.
    expect(await openCalls(ann.gameId)).toHaveLength(0);
  });

  it("puts nothing on the queue but the game, the power, the phase and the step", async () => {
    const sent: unknown[] = [];
    const ann = await create("Ann", { aiFill: true, aiBrain: "claude" });
    await inRoom(ann.gameId, (room) => {
      room.env = {
        ...room.env,
        ANTHROPIC_API_KEY: "sk-test-secret",
        AGENT_QUEUE: { sendBatch: async (messages: { body: unknown }[]) => void sent.push(...messages.map((m) => m.body)) } as never,
      };
    });
    await start(ann);
    await until(async () => sent.length === 6, "the turns to be queued");
    for (const body of sent) {
      expect(Object.keys(body as object).sort()).toEqual(["gameId", "phase", "power", "step"]);
      expect(body).toMatchObject({ gameId: ann.gameId, phase: "S1901M", step: "negotiate" });
    }
    // No credential of any kind: not the human's token, not a seat token, not the API key.
    expect(JSON.stringify(sent)).not.toMatch(/sk-test-secret|token|[0-9a-f]{32}/);
    expect(JSON.stringify(sent)).not.toContain(ann.token.split(".")[2]!);
  });
});

describe("AI takeover of a seat in civil disorder", () => {
  const seatOf = async (gameId: string, power: string) => (await summary(gameId)).seats.find((s) => s.power === power)!;

  it("hands a seat whose player has gone to a Claude agent in a Claude game, until the player returns", async () => {
    const { brain, requests } = scripted();
    const ann = await create("Ann", { aiFill: true, readyAdvance: true, aiBrain: "claude", press: "gunboat" });
    const bob = await join(ann.gameId, "Bob");
    brains.set(ann.gameId, brain);
    await inRoom(ann.gameId, (room) => {
      room.env = { ...room.env, ANTHROPIC_API_KEY: "test-key" };
    });
    await start(ann);
    await until(() => allReady(ann.gameId), "the AI seats to order", 20_000);
    expect(requests.some((r) => r.prompt.includes(`You are ${bob.power}.`))).toBe(false);
    // Bob has missed his turns: his seat is in civil disorder, already covered for this phase.
    await sql(ann.gameId, "UPDATE seats SET kind = 'civil_disorder', missed = 2, ready = 1 WHERE power = ?", bob.power);
    const { a, units } = await seated(ann);
    holdAndReady(a, units, "S1901M");
    await a.next("state", (m) => m.p.phase === "F1901M", 20_000);
    // The next phase opens with a Claude turn for Bob's seat, as for every AI seat.
    await until(async () => (await seatOf(ann.gameId, bob.power)).ready, "Claude to order for the seat", 20_000);
    const asked = requests.filter((r) => r.prompt.includes(`You are ${bob.power}.`));
    expect(asked.map((r) => r.step)).toEqual(["order"]);
    const filed = await sql<{ source: string }>(ann.gameId, "SELECT source FROM orders WHERE phase = 'F1901M' AND power = ?", bob.power);
    expect(filed).toEqual([{ source: "claude" }]);
    // An agent's orders are not the player coming back: the seat stays his and stays in civil disorder.
    expect(await seatOf(ann.gameId, bob.power)).toMatchObject({ kind: "civil_disorder", name: "Bob", autopilot: true, brain: "claude" });
    const call = await sql<{ outcome: string; cost_micros: number }>(ann.gameId, "SELECT outcome, cost_micros FROM agent_calls WHERE phase = 'F1901M' AND power = ?", bob.power);
    expect(call).toEqual([{ outcome: "answered", cost_micros: CALL_COST }]);
  }, 60_000);

  it("leaves a returning player's orders alone when the agent answers after they are back", async () => {
    const queued: AgentTurn[] = [];
    const ann = await create("Ann", { aiFill: true, readyAdvance: true, aiBrain: "claude", press: "gunboat" });
    const bob = await join(ann.gameId, "Bob");
    const power = bob.power as "FRANCE";
    await inRoom(ann.gameId, (room) => {
      room.env = {
        ...room.env,
        ANTHROPIC_API_KEY: "test-key",
        AGENT_QUEUE: { sendBatch: async (messages: { body: AgentTurn }[]) => void queued.push(...messages.map((m) => m.body)) } as never,
      };
    });
    await sql(ann.gameId, "UPDATE seats SET kind = 'civil_disorder', missed = 2 WHERE power = ?", power);
    await start(ann);
    await until(async () => queued.some((t) => t.power === power), "a turn for the seat in civil disorder");
    expect(queued.filter((t) => t.power === power)).toEqual([{ gameId: ann.gameId, power, phase: "S1901M", step: "order" }]);
    expect(await seatOf(ann.gameId, power)).toMatchObject({ ready: false, brain: "claude" });
    // The consumer claims the step; then Bob comes back and orders while the model is thinking.
    const room = stubOf(ann.gameId);
    expect(await room.agentBrief(power, "S1901M", "order")).toMatchObject({ power, step: "order" });
    const b = await Client.connect(ann.gameId, bob.token);
    const units = (await b.next("welcome")).p.state.units[power]!;
    b.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    await until(async () => (await seatOf(ann.gameId, power)).kind === "human", "Bob to take his seat back");
    // The agent's answer arrives late: it is billed, and refused.
    const moves = units.map((u) => `${u} H`);
    const report = { model: CLAUDE_MODEL, usage: USAGE, billed: "yes" } as const;
    expect(await room.agentSubmit(power, "S1901M", "order", { orders: moves, messages: [], pledge: null }, report)).toMatchObject({
      applied: false,
      reason: "not_an_ai_seat",
    });
    const filed = await sql<{ source: string }>(ann.gameId, "SELECT source FROM orders WHERE phase = 'S1901M' AND power = ?", power);
    expect(filed).toEqual([{ source: "human" }]);
    expect((await meta(ann.gameId)).claudeSpentMicros).toBe(CALL_COST);
    // Back in his hands, the seat is no longer the agent's to claim.
    expect(await seatOf(ann.gameId, power)).toMatchObject({ kind: "human", brain: null, autopilot: false });
    b.close();
  }, 60_000);
});

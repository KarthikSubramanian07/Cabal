/**
 * Claude seats: the queue consumer, the tokenless room RPC, the wait that stops a quick human
 * outrunning an AI turn, the timeout that stops an AI turn blocking a phase, and the spend cap.
 * No test here calls the real API: the consumer's brain is replaced by a scripted one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Brain, BrainReply, BrainRequest, Decision } from "@cabal/agents";
import { agentRuntime, playTurn } from "../src/agent-consumer.js";
import { Client, type Seat, create, fireAlarm, inRoom, serverEnv, sleep, sql, start, stubOf, summary, until } from "./helpers.js";

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

/** A brain that orders every unit to hold, optionally after `gate` resolves. */
function scripted(options: { gate?: Promise<void>; fail?: boolean; press?: boolean } = {}): { brain: Brain; calls: () => number } {
  let calls = 0;
  const brain: Brain = {
    async decide({ prompt }: BrainRequest): Promise<BrainReply> {
      calls++;
      await options.gate;
      if (options.fail) throw new Error("model unavailable");
      const holds = [...prompt.matchAll(/^ {2}([AF] [A-Z]{3}(?:\/[A-Z]{2})? H)$/gm)].map((m) => m[1]!);
      const decision: Decision = {
        reasoning: "Hold the line.",
        orders: [...new Set(holds)],
        messages: options.press ? [{ to: "ALL", body: "The line holds." }, { to: "NOWHERE", body: "dropped" }] : [],
        pledge: null,
        relationships: [],
        diary: "Held.",
      };
      return { decision, usage: null, model: null };
    },
  };
  return { brain, calls: () => calls };
}

/** One human and six Claude seats. The room is given a key so it asks the queue for turns. */
async function claudeGame(brain: Brain, envOver: Record<string, string> = {}): Promise<Seat> {
  const ann = await create("Ann", { aiFill: true, readyAdvance: true, aiBrain: "claude" });
  brains.set(ann.gameId, brain);
  await inRoom(ann.gameId, (room) => {
    room.env = { ...room.env, ANTHROPIC_API_KEY: "test-key", ...envOver };
  });
  await start(ann);
  return ann;
}

const aiSeats = async (gameId: string) => (await summary(gameId)).seats.filter((s) => s.kind === "ai");
const sources = async (gameId: string, phase: string) =>
  (await sql<{ source: string }>(gameId, "SELECT source FROM orders WHERE phase = ? ORDER BY power", phase)).map((r) => r.source);

describe("Claude seats", () => {
  it("plays every AI seat with the bot when the game did not ask for Claude, without touching the queue", async () => {
    const { brain, calls } = scripted();
    const ann = await create("Ann", { aiFill: true });
    brains.set(ann.gameId, brain);
    await inRoom(ann.gameId, (room) => {
      room.env = { ...room.env, ANTHROPIC_API_KEY: "test-key" };
    });
    await start(ann);
    expect((await aiSeats(ann.gameId)).every((s) => s.ready)).toBe(true);
    expect(await sources(ann.gameId, "S1901M")).toEqual(Array(6).fill("bot"));
    await sleep(300);
    expect(calls()).toBe(0);
    expect(await inRoom(ann.gameId, (room) => room.meta.claudeTurns)).toBe(0);
  });

  it("falls back to the bot when Claude was asked for but no key is configured", async () => {
    const ann = await create("Ann", { aiFill: true, aiBrain: "claude" });
    await start(ann);
    expect((await aiSeats(ann.gameId)).every((s) => s.ready)).toBe(true);
    expect(await inRoom(ann.gameId, (room) => room.meta.aiDueAt)).toBeNull();
  });

  it("asks the queue for each seat's turn, applies Claude's orders over the bot's, and advances when everyone is ready", async () => {
    const { brain, calls } = scripted({ press: true });
    const ann = await claudeGame(brain);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    // The queue delivers six turns; each replaces the bot's provisional orders and readies the seat.
    await until(async () => (await aiSeats(ann.gameId)).every((s) => s.ready), "all Claude seats to answer", 20_000);
    expect(calls()).toBe(6);
    expect(await sources(ann.gameId, "S1901M")).toEqual(Array(6).fill("claude"));
    expect(await inRoom(ann.gameId, (room) => room.meta)).toMatchObject({ claudeTurns: 6, aiDueAt: null });
    // Their press is ordinary press: capped, validated, and from their own seat.
    const press = await sql<{ sender: string; recipient: string; body: string }>(ann.gameId, "SELECT sender, recipient, body FROM press");
    expect(press).toHaveLength(6);
    expect(press.every((m) => m.recipient === "ALL" && m.body === "The line holds.")).toBe(true);
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    const results = await a.next("results");
    expect(results.p.results.every((r) => r.order.endsWith(" H"))).toBe(true);
  }, 40_000);

  it("H1: a human cannot resolve a phase while Claude seats are still thinking", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { brain } = scripted({ gate });
    const ann = await claudeGame(brain);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    expect((await aiSeats(ann.gameId)).every((s) => !s.ready)).toBe(true);
    // The bot's orders are already on file, so nothing can be lost while the model thinks.
    expect(await sources(ann.gameId, "S1901M")).toEqual(Array(6).fill("bot"));
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    for (let i = 0; i < 10; i++) a.send({ t: "ready", p: { phase: "S1901M", ready: i % 2 === 0 } });
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await sleep(400);
    expect((await summary(ann.gameId)).phase).toBe("S1901M");
    expect((await sql<{ n: number }>(ann.gameId, "SELECT COUNT(*) AS n FROM phases"))[0]!.n).toBe(0);
    // The seats answer and the phase resolves at once, with nobody readying again.
    open();
    expect((await a.next("state", (m) => m.p.phase === "F1901M", 20_000)).p.phase).toBe("F1901M");
  }, 40_000);

  it("never lets a slow Claude seat hold a phase: after the time limit the bot's orders stand", async () => {
    // The model does not answer until the test is over.
    let open!: () => void;
    const { brain } = scripted({ gate: new Promise<void>((resolve) => (open = resolve)) });
    const ann = await claudeGame(brain);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    const due = await inRoom(ann.gameId, (room) => room.meta.aiDueAt!);
    expect(due - Date.now()).toBeGreaterThan(80_000);
    expect(due - Date.now()).toBeLessThanOrEqual(90_000);
    // The alarm is set for the AI limit, well before the two-day phase deadline.
    expect(await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm())).toBe(due);
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await sleep(100);
    expect((await summary(ann.gameId)).phase).toBe("S1901M");
    await inRoom(ann.gameId, (room) => {
      room.meta.aiDueAt = Date.now() - 1;
    });
    await fireAlarm(ann.gameId);
    const results = await a.next("results");
    expect(results.p.phase).toBe("S1901M");
    // The AI seats were not left holding: their bot orders were adjudicated.
    expect(results.p.results.filter((r) => r.power !== ann.power && !r.order.endsWith(" H")).length).toBeGreaterThan(0);
    // The late answers arrive for a phase that is over and are refused.
    open();
    await sleep(300);
    expect((await sources(ann.gameId, "S1901M")).sort()).toEqual([...Array(6).fill("bot"), "human"]);
  }, 40_000);

  it("keeps the bot's orders when the model fails, and calls it once: no retry, no second bill", async () => {
    const { brain, calls } = scripted({ fail: true });
    const ann = await claudeGame(brain);
    await until(async () => (await aiSeats(ann.gameId)).every((s) => s.ready), "all Claude seats to close", 20_000);
    await sleep(300);
    expect(calls()).toBe(6);
    expect(await sources(ann.gameId, "S1901M")).toEqual(Array(6).fill("bot"));
  }, 40_000);

  it("A5: refuses a turn for a phase that has resolved, and never calls the model for it", async () => {
    const { brain, calls } = scripted();
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    brains.set(ann.gameId, brain);
    await start(ann);
    const ai = (await aiSeats(ann.gameId))[0]!.power as "FRANCE";
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await a.next("state", (m) => m.p.phase === "F1901M");
    const room = stubOf(ann.gameId);
    expect(await room.agentBrief(ai, "S1901M")).toBeNull();
    expect(await room.agentSubmit(ai, "S1901M", { orders: [], messages: [], pledge: null })).toEqual({ applied: false, reason: "stale_phase" });
    expect(await playTurn({ gameId: ann.gameId, power: ai, phase: "S1901M" }, serverEnv)).toBe("stale");
    expect(calls()).toBe(0);
    // A human seat can never be driven through the agent RPC.
    expect(await room.agentBrief(ann.power as "FRANCE", "F1901M")).toBeNull();
    expect(await room.agentSubmit(ann.power as "FRANCE", "F1901M", { orders: [], messages: [], pledge: null })).toEqual({
      applied: false,
      reason: "not_an_ai_seat",
    });
  });

  it("stops asking Claude once the game has spent its turn budget", async () => {
    const { brain, calls } = scripted();
    const ann = await claudeGame(brain, { CLAUDE_TURNS_PER_GAME: "4" });
    await until(async () => (await aiSeats(ann.gameId)).every((s) => s.ready), "all AI seats to be ready", 20_000);
    expect(await inRoom(ann.gameId, (room) => room.meta.claudeTurns)).toBe(4);
    expect(calls()).toBe(4);
    expect((await sources(ann.gameId, "S1901M")).sort()).toEqual(["bot", "bot", "claude", "claude", "claude", "claude"]);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await a.next("state", (m) => m.p.phase === "F1901M");
    // The budget is spent: the next phase is all bot, ready at once, with no further model calls.
    expect((await aiSeats(ann.gameId)).every((s) => s.ready)).toBe(true);
    expect(await sources(ann.gameId, "F1901M")).toEqual(Array(6).fill("bot"));
    await sleep(300);
    expect(calls()).toBe(4);
  }, 40_000);

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
    await until(async () => (await aiSeats(ann.gameId)).every((s) => s.ready), "the AI seats to be released");
    expect(await inRoom(ann.gameId, (room) => room.meta.aiDueAt)).toBeNull();
  });
});

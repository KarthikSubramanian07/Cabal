import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, mapInfo, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { BotBrain, unitInterval } from "./bot-brain.js";
import { BrainFailure, PERSONAS, Player, validateOrders } from "./player.js";
import { type PromptInput, systemPrompt, userPrompt } from "./prompt.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

function situation(power: string, extra: Partial<PromptInput> = {}): PromptInput {
  const game = new Game();
  const input: PromptInput = {
    power,
    persona: PERSONAS[power]!,
    phase: game.phase(),
    state: game.state(),
    map: mapInfo(),
    legal: game.legal(power),
    press: [],
    myPledges: [],
    trust: {},
    diary: [],
    relationships: [],
    ...extra,
  };
  game.free();
  return input;
}

const ask = (s: PromptInput, step: "negotiate" | "order") => ({ system: systemPrompt(s.map), prompt: userPrompt(s), kind: "M" as const, step, situation: s });

describe("BotBrain", () => {
  it("gives the Rust bot's legal orders, free and unmetered", async () => {
    const s = situation("FRANCE");
    const reply = await new BotBrain({ seed: "G1" }).decide(ask(s, "order"));
    expect(reply.usage).toBeNull();
    expect(reply.model).toBe("cabal-bot/standard");
    const v = validateOrders(reply.decision, s.legal);
    expect(v.dropped).toEqual([]);
    expect(v.orders).toHaveLength(3);
  });

  it("is deterministic for a seed", async () => {
    const s = situation("RUSSIA");
    const a = await new BotBrain({ seed: "same", level: "hard" }).decide(ask(s, "order"));
    const b = await new BotBrain({ seed: "same", level: "hard" }).decide(ask(s, "order"));
    expect(b).toEqual(a);
  });

  it("opens a movement phase with press and a pledge made of its own planned orders", async () => {
    const replies = await Promise.all(
      ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"].map(async (power) => {
        const s = situation(power);
        return { s, reply: await new BotBrain({ seed: "TALK" }).decide(ask(s, "negotiate")) };
      }),
    );
    const pledging = replies.filter(({ reply }) => reply.decision.pledge !== null);
    expect(pledging.length).toBeGreaterThan(0);
    for (const { s, reply } of pledging) {
      const pledge = reply.decision.pledge!;
      expect(reply.decision.messages.map((m) => m.to)).toContain(pledge.to);
      expect(pledge.to).not.toBe(s.power);
      for (const o of pledge.orders) expect(reply.decision.orders).toContain(o);
    }
  });

  it("keeps its pledges unless it was built to break them, and then breaks one by moving the unit", async () => {
    const opening = situation("ITALY");
    const talk = await new BotBrain({ seed: "STAB" }).decide(ask(opening, "negotiate"));
    const pledge = talk.decision.pledge;
    expect(pledge).not.toBeNull();
    const after = situation("ITALY", {
      press: [{ from: "ITALY", to: pledge!.to, body: "pledged", pledge: pledge!.orders }],
      myPledges: [pledge!.orders],
    });
    const loyal = await new BotBrain({ seed: "STAB" }).decide(ask(after, "order"));
    for (const o of pledge!.orders) expect(loyal.decision.orders).toContain(o);
    const traitor = await new BotBrain({ seed: "STAB", treachery: 1 }).decide(ask(after, "order"));
    expect(pledge!.orders.some((o) => !traitor.decision.orders.includes(o))).toBe(true);
    expect(validateOrders(traitor.decision, after.legal).dropped).toEqual([]);
    expect(traitor.decision.diary).toMatch(/^Broke my word to /);
  });

  it("fails cleanly without the structured situation, so a player holds instead of crashing", async () => {
    await expect(new BotBrain({ seed: 1 }).decide({ system: "", prompt: "", kind: "M", step: "order" })).rejects.toBeInstanceOf(BrainFailure);
  });

  it("plays through Player like any other brain", async () => {
    const game = new Game();
    const player = new Player("TURKEY", PERSONAS["TURKEY"]!, new BotBrain({ seed: "P" }));
    const played = await player.play({ phase: "S1901M", state: game.state(), map: mapInfo(), legal: game.legal("TURKEY"), press: [], myPledges: [], trust: {} });
    game.free();
    expect(played.fallback).toBe(false);
    expect(played.costMicros).toBe(0);
    expect(played.validated.orders).toHaveLength(3);
  });
});

describe("unitInterval", () => {
  it("spreads seeds over [0, 1)", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => unitInterval(`s${i}`));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const low = xs.filter((x) => x < 0.5).length;
    expect(low).toBeGreaterThan(400);
    expect(low).toBeLessThan(600);
  });
});

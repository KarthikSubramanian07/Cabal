/**
 * The deployment-wide Claude budget. A room caps what one game may spend; only the index can see
 * every room, so it is the index that admits a game to Claude at all: a daily budget in dollars
 * and a limit on Claude games in play. These tests narrow those limits (the rest of the run has
 * them wide open) and never call the real API: turns are queued and never delivered.
 */
import { runInDurableObject } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentTurn, Env } from "../src/env.js";
import { CLAUDE_BUDGET, type Registry } from "../src/registry.js";
import { LIMITS } from "../src/room.js";
import { Client, type Seat, create, inRoom, registry, sleep, sql, start, summary, until, untilIndexed, untilStatus } from "./helpers.js";

const limits = (over: Partial<Pick<Env, "CLAUDE_USD_PER_DAY" | "CLAUDE_ACTIVE_GAMES">>) =>
  runInDurableObject(registry(), (instance: Registry) => {
    const holder = instance as unknown as { env: Env; original?: Env };
    holder.original ??= holder.env;
    holder.env = { ...holder.original, ...over };
  });

afterAll(() =>
  runInDurableObject(registry(), (instance: Registry) => {
    const holder = instance as unknown as { env: Env; original?: Env };
    if (holder.original) holder.env = holder.original;
  }),
);

const USD = 1_000_000;
/** Far from today, so these rows and the ones real games leave behind never count for each other. */
const DAY = Date.UTC(2021, 2, 1, 12);

describe("the index as the budget's keeper", () => {
  it("has defaults a deployment can live with when nothing is configured", () => {
    expect(CLAUDE_BUDGET).toEqual({ usdPerDay: 20, activeGames: 4 });
    // By default a day admits no more games than its budget covers in full.
    expect(CLAUDE_BUDGET.usdPerDay / LIMITS.claudeUsdPerGame).toBe(CLAUDE_BUDGET.activeGames);
  });

  it("limits the Claude games in play, and frees a place when one ends", async () => {
    await limits({ CLAUDE_ACTIVE_GAMES: "2", CLAUDE_USD_PER_DAY: "1000" });
    const ask = (gameId: string) => registry().admitClaudeGame({ gameId, capMicros: 5 * USD, now: DAY });
    expect(await ask("PLAY01")).toEqual({ admitted: true, reason: null });
    expect(await ask("PLAY02")).toEqual({ admitted: true, reason: null });
    expect(await ask("PLAY03")).toEqual({ admitted: false, reason: "claude_games_full" });
    // Asking again changes nothing: a game is admitted once.
    expect(await ask("PLAY01")).toEqual({ admitted: true, reason: null });
    expect((await registry().claudeBudget(DAY)).activeGames).toBe(2);
    await registry().releaseClaudeGame({ gameId: "PLAY01", spentMicros: 2 * USD, now: DAY + 1 });
    await registry().releaseClaudeGame({ gameId: "PLAY01", spentMicros: 4 * USD, now: DAY + 2 });
    expect(await ask("PLAY03")).toEqual({ admitted: true, reason: null });
    // A game that has ended does not come back for more.
    expect(await ask("PLAY01")).toEqual({ admitted: false, reason: "claude_game_over" });
    expect(await registry().claudeBudget(DAY)).toMatchObject({ activeGames: 2, maxActiveGames: 2, committedUsd: 12 });
  });

  it("holds a daily budget: a game commits its whole cap, and hands back what it did not spend", async () => {
    const day = DAY + 40 * 24 * 3600_000;
    await limits({ CLAUDE_ACTIVE_GAMES: "100", CLAUDE_USD_PER_DAY: "12" });
    const ask = (gameId: string, now = day) => registry().admitClaudeGame({ gameId, capMicros: 5 * USD, now });
    expect((await ask("DAY001")).admitted).toBe(true);
    expect((await ask("DAY002")).admitted).toBe(true);
    // Ten dollars are committed; a third game's five would pass twelve.
    expect(await ask("DAY003")).toEqual({ admitted: false, reason: "claude_daily_budget" });
    expect(await registry().claudeBudget(day)).toMatchObject({ committedUsd: 10, capUsd: 12 });
    // The first game ends having spent one dollar: four come back.
    await registry().releaseClaudeGame({ gameId: "DAY001", spentMicros: 1 * USD, now: day + 1 });
    expect((await ask("DAY003")).admitted).toBe(true);
    expect(await ask("DAY004")).toEqual({ admitted: false, reason: "claude_daily_budget" });
    // A report of more than the cap (it cannot happen) never counts for more than the cap.
    await registry().releaseClaudeGame({ gameId: "DAY002", spentMicros: 99 * USD, now: day + 2 });
    expect((await registry().claudeBudget(day)).committedUsd).toBe(11);
    // Tomorrow is a new day.
    expect((await ask("DAY004", day + 24 * 3600_000)).admitted).toBe(true);
  });
});

/** A Claude game whose turns are queued and never delivered. */
async function claudeGame(over: Partial<Env> = {}): Promise<{ ann: Seat; queued: AgentTurn[] }> {
  const queued: AgentTurn[] = [];
  const ann = await create("Ann", { aiFill: true, aiBrain: "claude", press: "gunboat" });
  await inRoom(ann.gameId, (room) => {
    room.env = {
      ...room.env,
      ANTHROPIC_API_KEY: "test-key",
      AGENT_QUEUE: { sendBatch: async (messages: { body: AgentTurn }[]) => void queued.push(...messages.map((m) => m.body)) } as never,
      ...over,
    };
  });
  expect((await start(ann)).status).toBe(200);
  await sleep(100);
  return { ann, queued };
}

describe("rooms under the budget", () => {
  it("B4: one visitor cannot open one Claude game after another: past the limit the bot plays", async () => {
    await limits({ CLAUDE_ACTIVE_GAMES: "1", CLAUDE_USD_PER_DAY: "1000" });
    const first = await claudeGame();
    expect(first.queued).toHaveLength(6);
    expect((await summary(first.ann.gameId)).ai).toMatchObject({ brain: "claude", stopped: null });

    // Four more games from the same script: none of them reaches the model.
    const refused: AgentTurn[] = [];
    for (let i = 0; i < 4; i++) {
      const next = await claudeGame();
      refused.push(...next.queued);
      const s = await summary(next.ann.gameId);
      expect(s.status).toBe("active");
      expect(s.ai).toMatchObject({ brain: "bot", stopped: "claude_games_full", claudeCalls: 0 });
      // The game is not held up or left without orders: every AI seat is ready with the bot's.
      expect(s.seats.filter((x) => x.kind === "ai").every((x) => x.ready && x.submitted)).toBe(true);
      expect(await sql(next.ann.gameId, "SELECT 1 FROM agent_calls")).toEqual([]);
    }
    expect(refused).toEqual([]);

    // When the first game ends its place is free again.
    const a = await Client.connect(first.ann.gameId, first.ann.token);
    await a.next("welcome");
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    await untilStatus(first.ann.gameId, "finished");
    await untilIndexed(first.ann.gameId);
    await until(async () => (await registry().claudeBudget(Date.now())).activeGames === 0, "the place to be handed back");
    const again = await claudeGame();
    expect(again.queued).toHaveLength(6);
    a.close();
  });

  it("B4: a refused game is told why once and never asks again", async () => {
    await limits({ CLAUDE_ACTIVE_GAMES: "100", CLAUDE_USD_PER_DAY: "0" });
    const { ann, queued } = await claudeGame();
    expect(queued).toEqual([]);
    expect((await summary(ann.gameId)).ai).toMatchObject({ brain: "bot", stopped: "claude_daily_budget" });
    const meta = await inRoom(ann.gameId, (room) => structuredClone(room.meta) as unknown as { claudeAdmission: string; claudeOff: string });
    expect(meta).toMatchObject({ claudeAdmission: "refused", claudeOff: "claude_daily_budget" });
  });

  it("B4: with no index to ask, or one that does not answer, a game gets no model calls", async () => {
    const none = await claudeGame({ REGISTRY: undefined as never });
    expect(none.queued).toEqual([]);
    expect((await summary(none.ann.gameId)).ai.stopped).toBe("no_budget_authority");
    const down = await claudeGame({
      REGISTRY: { idFromName: () => "id", get: () => ({ admitClaudeGame: async () => Promise.reject(new Error("down")) }) } as never,
    });
    expect(down.queued).toEqual([]);
    expect((await summary(down.ann.gameId)).ai.stopped).toBe("budget_unreachable");
  });
});

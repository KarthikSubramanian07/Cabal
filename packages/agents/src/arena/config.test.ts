import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, POWERS, mapInfo, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { type Brain, BrainFailure, CLAUDE_TIMEOUT_MS, ClaudeBrain, Player } from "../player.js";
import { ArenaUsageError, arenaClaude, arenaPlayers, parseArenaArgs, runCap } from "./config.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

const KEY = { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" };
const parse = (args: string, env: Record<string, string> = {}) => {
  const config = parseArenaArgs(args ? args.split(" ") : [], env);
  if (config === "help") throw new Error("help");
  return config;
};

/** A model brain that must never be reached in these tests, and counts the attempts if it is. */
class Unreachable implements Brain {
  calls = 0;
  async decide(): Promise<never> {
    this.calls++;
    throw new BrainFailure("no network in tests", "no");
  }
}

function opening(power: string) {
  const game = new Game();
  const input = { phase: game.phase(), state: game.state(), map: mapInfo(), legal: game.legal(power), press: [], myPledges: [], trust: {} };
  game.free();
  return input;
}

describe("pnpm arena options", () => {
  it("is free by default: seven bot seats, no budget, ten years", () => {
    const c = parse("");
    expect(c).toMatchObject({ games: 1, untilYear: 1910, claude: [], budgetMicros: 0, server: null, wrangler: false, press: "full" });
    const players = arenaPlayers(c, "ARENA1", runCap(c), () => {
      throw new Error("no Claude brain may be built for a bot run");
    });
    expect(players.map((p) => p.power)).toEqual([...POWERS]);
  });

  it("refuses Claude seats without an API key, and without a hard budget", () => {
    expect(() => parse("--claude FRANCE --budget 1")).toThrow(ArenaUsageError);
    expect(() => parse("--claude FRANCE --budget 1")).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => parse("--claude FRANCE", KEY)).toThrow(/--budget/);
    expect(() => parse("--claude FRANCE --budget 0", KEY)).toThrow(/--budget/);
    expect(() => parse("--claude FRANCE --budget 500", KEY)).toThrow(/--budget/);
    expect(() => parse("--budget 1", KEY)).toThrow(/bot seats are free/);
    expect(() => parse("--claude NARNIA --budget 1", KEY)).toThrow(/unknown power/);
  });

  it("rejects bad numbers and contradictory servers", () => {
    expect(() => parse("--games 0")).toThrow(/--games/);
    expect(() => parse("--until 1899")).toThrow(/--until/);
    expect(() => parse("--treachery 2")).toThrow(/--treachery/);
    expect(() => parse("--levels hard,godlike")).toThrow(/godlike/);
    expect(() => parse("--press loud")).toThrow(/--press/);
    expect(() => parse("--server http://localhost:8787 --wrangler")).toThrow(/pick one/);
    expect(() => parse("--frobnicate")).toThrow(ArenaUsageError);
    expect(parseArenaArgs(["--help"], {})).toBe("help");
  });

  it("puts each Claude seat under its share of the budget and under the run cap", () => {
    const c = parse("--claude FRANCE,ITALY --budget 2 --games 4", KEY);
    expect(c.claude).toEqual(["FRANCE", "ITALY"]);
    expect(c.budgetMicros).toBe(2_000_000);
    const run = runCap(c)!;
    expect(run.capMicros).toBe(2_000_000);
    const built: string[] = [];
    arenaPlayers(c, "ARENA1", run, (model) => {
      built.push(model);
      return new Unreachable();
    });
    expect(built).toEqual([c.model, c.model]);
    expect(parse("--claude all --budget 1", KEY).claude).toEqual([...POWERS]);
  });

  it("never lets one decision of a paid seat become more than one request", () => {
    // The SDK retries twice by default and waits ten minutes; each retry could be billed while the
    // seat's cap reserved one call. Building a client sends nothing.
    const sdk = (brain: ClaudeBrain) => (brain as unknown as { client: { maxRetries: number; timeout: number } }).client;
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-test-not-a-key";
    try {
      expect(sdk(arenaClaude("claude-opus-5-5"))).toMatchObject({ maxRetries: 0, timeout: CLAUDE_TIMEOUT_MS });
      expect(sdk(new ClaudeBrain())).toMatchObject({ maxRetries: 0, timeout: CLAUDE_TIMEOUT_MS });
      expect(sdk(new ClaudeBrain({ maxRetries: 1, timeoutMs: 5_000 }))).toMatchObject({ maxRetries: 1, timeout: 5_000 });
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("plays the bot's orders when a Claude seat's cap cannot cover one call, without calling the model", async () => {
    // One cent over a whole run: less than the worst case of a single call, so nothing is attempted.
    const c = parse("--claude FRANCE --budget 0.01", KEY);
    const brain = new Unreachable();
    const players = arenaPlayers(c, "ARENA1", runCap(c), () => brain);
    const france = players.find((p) => p.power === "FRANCE")!;
    expect(france).toBeInstanceOf(Player);
    const played = await france.play(opening("FRANCE"));
    expect(brain.calls).toBe(0);
    expect(played.fallback).toBe(false);
    expect(played.failover).toMatch(/seat budget reached|run budget reached/);
    expect(played.model).toMatch(/^cabal-bot\//);
    expect(played.validated.orders).toHaveLength(3);
    expect(played.costMicros).toBe(0);
  });

  it("gives every bot seat the game's seed, so a game replays from its id", async () => {
    const c = parse("");
    const a = arenaPlayers(c, "SEEDA1", null);
    const b = arenaPlayers(c, "SEEDA1", null);
    const [x, y] = await Promise.all([a[2]!.play(opening(a[2]!.power)), b[2]!.play(opening(b[2]!.power))]);
    expect(x.validated.orders).toEqual(y.validated.orders);
  });
});

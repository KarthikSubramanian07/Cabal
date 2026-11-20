import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, POWERS, ready, verifySaved } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { BotBrain } from "../bot-brain.js";
import { type Brain, type BrainReply, type BrainRequest, PERSONAS, Player } from "../player.js";
import { runLocalArena } from "./local.js";
import { type SavedPledge, phaseLogs } from "./saved.js";
import { arenaReport, gateFailures, summarise } from "./summary.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

const bots = (seed: string, treachery = 0) =>
  POWERS.map((power, i) => new Player(power, PERSONAS[power]!, new BotBrain({ seed, level: (["easy", "standard", "hard"] as const)[i % 3]!, treachery })));

const GATES = { maxOffMenuRate: 0.01, maxCostMicros: 0, untilYear: 1903 };

// Each game takes about a second on a quiet machine; a loaded CI runner gets the minute the issue allows.
describe("the local arena", { timeout: 60_000 }, () => {
  it("plays seven bots through three years in well under a minute, legally, and the game replays", async () => {
    const started = Date.now();
    const game = await runLocalArena({ gameId: "SMOKE1", players: bots("SMOKE1", 0.3), untilYear: 1903 });
    expect(Date.now() - started).toBeLessThan(60_000);
    const s = summarise(game);
    expect(s.years).toEqual([1901, 1902, 1903]);
    expect(s.lastPhase).toMatch(/^W1903A$|^F1903[MR]$/);
    expect(s.seats.map((x) => x.power)).toEqual([...POWERS]);
    expect(s.totals.illegalSubmitted).toBe(0);
    expect(s.totals.offMenu).toBe(0);
    expect(s.totals.fallbacks).toBe(0);
    expect(s.divergences).toBe(0);
    expect(s.totals.costMicros).toBe(0);
    // The bots talk and pledge, and some of those pledges are broken on purpose.
    expect(s.totals.messages).toBeGreaterThan(0);
    expect(s.totals.pledges.made).toBeGreaterThan(0);
    expect(s.totals.pledges.kept).toBeGreaterThan(0);
    expect(s.totals.pledges.broken).toBeGreaterThan(0);
    expect(gateFailures(s, GATES)).toEqual([]);
    // Centres per year add up to the 22 owned at the start and never exceed the 34 on the board.
    expect(s.seats.reduce((n, x) => n + x.centres[0]!, 0)).toBeGreaterThanOrEqual(22);
    for (let y = 0; y < 3; y++) expect(s.seats.reduce((n, x) => n + x.centres[y]!, 0)).toBeLessThanOrEqual(34);
  });

  it("saves press and pledges with their receipts, and the file replays exactly", async () => {
    const game = await runLocalArena({ gameId: "PRESS1", players: bots("PRESS1", 0.5), untilYear: 1902 });
    const saved = JSON.parse(game.saved) as {
      phases: { name: string; messages: unknown[] }[];
      cabal: { pledges: { receipt?: string }[] };
    };
    expect(saved.phases.some((p) => p.messages.length > 0)).toBe(true);
    expect(saved.cabal.pledges.length).toBeGreaterThan(0);
    expect(saved.cabal.pledges.every((p) => p.receipt === "kept" || p.receipt === "broken" || p.receipt === "void")).toBe(true);
    expect(verifySaved(game.saved).divergences).toEqual([]);
    const restored = Game.fromSaved(game.saved);
    expect(restored.phase()).toBe(JSON.parse(game.saved).phases.at(-1).name);
    restored.free();
  });

  it("is reproducible: the same seed gives the same game, byte for byte", async () => {
    const a = await runLocalArena({ gameId: "SAME01", players: bots("SAME01", 0.3), untilYear: 1902 });
    const b = await runLocalArena({ gameId: "SAME01", players: bots("SAME01", 0.3), untilYear: 1902 });
    expect(b.saved).toBe(a.saved);
  });

  it("feeds receipts into the trust ledger every seat reads", async () => {
    const seen: BrainRequest[] = [];
    const watcher: Brain = {
      async decide(request: BrainRequest): Promise<BrainReply> {
        seen.push(request);
        return new BotBrain({ seed: "LEDGER" }).decide(request);
      },
    };
    const players = bots("LEDGER", 1);
    players[0] = new Player("AUSTRIA", PERSONAS["AUSTRIA"]!, watcher);
    const game = await runLocalArena({ gameId: "LEDGER", players, untilYear: 1902 });
    const broken = game.phases.flatMap((p) => p.pledges).filter((r) => r.receipt === "broken" && r.pledger !== "AUSTRIA");
    expect(broken.length).toBeGreaterThan(0);
    const last = seen.at(-1)!;
    const ledger = last.situation!.trust;
    expect(Object.values(ledger).some((t) => t.broken > 0)).toBe(true);
    const section = last.prompt.split("# Trust ledger\n")[1]!.split("\n\n")[0]!;
    expect(section).toMatch(/^[A-Z]+: kept \d+, broken [1-9]\d*$/m);
  });

  it("plays a gunboat game in one silent step per phase", async () => {
    const game = await runLocalArena({ gameId: "GUNBT1", players: bots("GUNBT1"), untilYear: 1901, press: "gunboat" });
    expect(game.records.every((r) => r.step === "order")).toBe(true);
    expect(summarise(game).totals.pledges.made).toBe(0);
    expect(JSON.parse(game.saved).phases.every((p: { messages: unknown[] }) => p.messages.length === 0)).toBe(true);
  });

  it("writes a report with the measures the nightly run tracks", async () => {
    const game = await runLocalArena({ gameId: "REPORT", players: bots("REPORT", 0.3), untilYear: 1901 });
    const report = arenaReport([summarise(game)], { ...GATES, untilYear: 1901 });
    expect(report).toContain("All 1 games pass the gates.");
    for (const heading of ["Off-menu", "Illegal submitted", "Hold rate", "Honesty", "Cost", "Replay"]) expect(report).toContain(heading);
    expect(report).toContain("| AUSTRIA | cabal-bot/easy |");
  });
});

describe("phase logs read back from a saved game", { timeout: 60_000 }, () => {
  it("match the log the arena kept while refereeing, phase for phase", async () => {
    const game = await runLocalArena({ gameId: "BACK01", players: bots("BACK01", 0.4), untilYear: 1903 });
    const back = phaseLogs(game.saved);
    expect(back).toEqual(game.phases);
    expect(summarise({ ...game, phases: back })).toEqual(summarise(game));
  });

  it("count each pledge once when several seats saw it, and skip pledges not yet receipted", async () => {
    const game = await runLocalArena({ gameId: "BACK02", players: bots("BACK02", 0.4), untilYear: 1901 });
    const pledges = (JSON.parse(game.saved) as { cabal: { pledges: SavedPledge[] } }).cabal.pledges;
    expect(pledges.length).toBeGreaterThan(0);
    const seenTwice = [...pledges, ...pledges, { ...pledges[0]!, id: "LATE", receipt: null }];
    expect(phaseLogs(game.saved, seenTwice)).toEqual(game.phases);
  });
});

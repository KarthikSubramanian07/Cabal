/**
 * `pnpm arena`: play AI seats against each other and write the run up. See `USAGE` in config.ts.
 *
 * Writes, under `--out`:
 *   games/<id>.json          the MILA saved game, press, pledges and receipts included
 *   decisions/<id>.jsonl     one decision record per line: prompt, decision, dropped orders, tokens, cost
 *   summary.json             every game's summary and the gates it was held to
 *   summary.md               the same as a Markdown report
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ready } from "@cabal/engine";
import { microsToUsd } from "../cost.js";
import { ArenaUsageError, USAGE, arenaPlayers, parseArenaArgs, runCap } from "./config.js";
import { type ArenaGame, runLocalArena } from "./local.js";
import { runServerArena } from "./server.js";
import { type Gates, arenaReport, gateFailures, summarise } from "./summary.js";
import { type LocalServer, startWrangler } from "./wrangler.js";

async function main(): Promise<number> {
  let config;
  try {
    config = parseArenaArgs(process.argv.slice(2).filter((a) => a !== "--"), process.env);
  } catch (error) {
    if (!(error instanceof ArenaUsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (config === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  await ready(readFileSync(new URL(import.meta.resolve("@cabal/engine/wasm"))));
  const out = resolve(process.env.INIT_CWD ?? process.cwd(), config.out);
  mkdirSync(join(out, "games"), { recursive: true });
  mkdirSync(join(out, "decisions"), { recursive: true });
  const say = (line: string) => process.stderr.write(`arena: ${line}\n`);
  if (config.claude.length > 0) {
    say(`Claude plays ${config.claude.join(", ")} with ${config.model}, under a hard cap of $${microsToUsd(config.budgetMicros).toFixed(2)} for the run`);
  }

  let server: LocalServer | null = null;
  const run = runCap(config);
  const summaries = [];
  try {
    if (config.wrangler) server = await startWrangler(8799, say);
    const url = server?.url ?? config.server;
    for (let n = 1; n <= config.games; n++) {
      const seedId = `${config.seed}${n}`;
      const players = arenaPlayers(config, seedId, run);
      const base = { players, untilYear: config.untilYear, press: config.press, negotiate: config.negotiate };
      const game: ArenaGame = url ? await runServerArena({ ...base, serverUrl: url }) : await runLocalArena({ ...base, gameId: seedId });
      const lines = game.records.map((r) => JSON.stringify(config.prompts ? r : { ...r, prompt: undefined }));
      writeFileSync(join(out, "games", `${game.gameId}.json`), game.saved);
      writeFileSync(join(out, "decisions", `${game.gameId}.jsonl`), lines.join("\n") + (lines.length ? "\n" : ""));
      const s = summarise(game);
      summaries.push(s);
      say(
        `${game.gameId}: ${s.status === "active" ? `played to ${s.lastPhase}` : s.status} in ${(s.elapsedMs / 1000).toFixed(1)} s, ` +
          `${s.totals.illegalSubmitted} illegal, ${s.totals.offMenu} off-menu, hold rate ${(s.totals.holdRate * 100).toFixed(1)}%, ` +
          `pledges ${s.totals.pledges.kept} kept / ${s.totals.pledges.broken} broken, $${s.totals.costUsd.toFixed(4)}`,
      );
    }
  } finally {
    await server?.stop();
  }
  const gates: Gates = { maxOffMenuRate: 0.01, maxCostMicros: config.budgetMicros, untilYear: config.untilYear };
  const where = config.wrangler ? "through wrangler dev" : config.server ? `through ${config.server}` : "in process";
  const title = `Agent arena: ${config.claude.length ? "bot and Claude seats" : "bot seats"}, ${where}`;
  const report = arenaReport(summaries, gates, title);
  writeFileSync(join(out, "summary.json"), JSON.stringify({ gates, games: summaries }, null, 2) + "\n");
  writeFileSync(join(out, "summary.md"), report);
  const failures = summaries.flatMap((s) => gateFailures(s, gates));
  // A bill above its reservation means a cost bound was wrong. Say so; the run fails its check.
  const overrun = run?.overrunMicros() ?? 0;
  if (overrun > 0) failures.push(`the run was billed $${microsToUsd(overrun).toFixed(4)} more than it reserved`);
  say(`${summaries.length} games written to ${out}; ${failures.length === 0 ? "every gate passes" : `${failures.length} gate failures`}`);
  return config.check && failures.length > 0 ? 1 : 0;
}

process.exitCode = await main();

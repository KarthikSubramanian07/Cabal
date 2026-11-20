#!/usr/bin/env node
/**
 * A full seven seat game with no operator (docs/PLAN.md section 8, issues #8 and #57): two scripted
 * people and five seats played by the bot, from the lobby to `finished`, over the public API only.
 *
 *   node tools/metrics/full-game.mjs <origin> [--humans 2] [--until 1905] [--timeout 600] [--record <where>]
 *
 * Each person files holds for their units in every movement phase (so the table never counts as
 * deserted) and readies in every phase; the bots are ready at once, so a phase resolves as soon as
 * both people are. From the `--until` year on, both vote for a draw. It passes when the game ends
 * `finished` (a solo, the engine's last year, or the draw) before the timeout. It creates a real,
 * unlisted game wherever it is pointed, so against production it is run by a maintainer, never CI.
 */
import { connectSeat, createGame, startGame } from "./lib/probe.mjs";
import { isMain, line, option, record } from "./lib/report.mjs";

const yearOf = (phase) => Number(/^[SFW](\d{4})/.exec(phase)?.[1] ?? 0);

export async function playFullGame(origin, { humans = 2, untilYear = 1905, timeoutMs = 600_000, log = () => undefined } = {}) {
  const startedAt = Date.now();
  const game = await createGame(origin, { humans, settings: { pacing: "live" }, stem: "Full game probe" });
  await startGame(origin, game);
  const seats = await Promise.all(game.seats.map((s) => connectSeat(origin, game.gameId, s.token)));
  const phases = new Set();
  let finished = null;
  let lastPhase = "";

  const ended = new Promise((resolve) => {
    for (const seat of seats) {
      const power = seat.welcome.p.power;
      const voted = new Set();
      const act = (phase, state, status) => {
        if (status !== "active") return;
        phases.add(phase);
        if (phase !== lastPhase) log(`${phase}`);
        lastPhase = phase;
        if (phase.endsWith("M")) {
          const holds = (state.units[power] ?? []).map((unit) => `${unit} H`);
          if (holds.length > 0) seat.send({ t: "orders.set", p: { phase, orders: holds } });
          if (yearOf(phase) >= untilYear && !voted.has(phase)) {
            voted.add(phase);
            seat.send({ t: "vote", p: { kind: "draw", value: true } });
          }
        }
        seat.send({ t: "ready", p: { phase, ready: true } });
      };
      const welcome = seat.welcome.p;
      act(welcome.phase, welcome.state, welcome.status);
      seat.ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.t === "state") act(frame.p.phase, frame.p.state, frame.p.status);
        if (frame.t === "finished" || (frame.t === "state" && (frame.p.status === "finished" || frame.p.status === "abandoned"))) {
          finished ??= { status: frame.p.status ?? "finished", ...(frame.t === "finished" ? frame.p : {}) };
          resolve();
        }
      });
    }
  });
  const timedOut = new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.());
  await Promise.race([ended, timedOut]);
  for (const seat of seats) seat.close();
  // The summary is the record of what happened, whatever the sockets saw.
  const summary = await (await fetch(new URL(`/api/games/${game.gameId}`, origin))).json();
  return {
    gameId: game.gameId,
    status: summary.status,
    result: summary.finished?.result ?? null,
    reason: summary.finished?.reason ?? null,
    phases: phases.size,
    lastPhase: summary.phase ?? lastPhase,
    humans,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const origin = args.find((a) => /^https?:\/\//.test(a));
  if (!origin) {
    console.error("usage: node tools/metrics/full-game.mjs <origin> [--humans 2] [--until 1905] [--timeout 600] [--record <where>]");
    process.exit(2);
  }
  const result = await playFullGame(origin, {
    humans: Number(option(args, "humans", "2")),
    untilYear: Number(option(args, "until", "1905")),
    timeoutMs: Number(option(args, "timeout", "600")) * 1000,
    log: (phase) => process.stderr.write(`${phase} `),
  });
  process.stderr.write("\n");
  console.log(JSON.stringify({ origin, ...result }));
  const pass = result.status === "finished";
  const where = option(args, "record", null);
  if (where) {
    record(
      line({
        id: "full_game",
        value: `${pass ? "finished" : result.status}: ${result.result ?? "no result"} by ${result.reason ?? "nothing"} after ${result.phases} phases, ${result.seconds} s, ${result.humans} people and ${7 - result.humans} bots`,
        pass,
        where,
        detail: { origin, ...result },
      }),
    );
  }
  process.exitCode = pass ? 0 : 1;
}

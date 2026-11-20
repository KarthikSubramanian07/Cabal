#!/usr/bin/env node
/**
 * Order submit round trip (docs/PLAN.md section 8, issue #57): `orders.set` to its `orders.ack`,
 * over the public API and a real seat socket, as a browser would send it.
 *
 *   node tools/metrics/order-rtt.mjs <origin> [--n 50] [--gap 120] [--record <where>]
 *
 * Makes an unlisted game with AI fill, binds the creator's seat, then files the seat's holds `n`
 * times, one at a time (`gap` ms apart, inside the room's per-socket rate), each with its own `id`,
 * and prints p50, p95 and p99. `--record <where>` writes the line into tools/metrics/metrics.json
 * (and metrics.md) under that place name; the verdict is p95 under 150 ms. A machine far from a
 * Cloudflare edge measures its own distance too: the target is for a browser in Europe or North
 * America, and the browsers' own figures arrive through the beacon (GET /api/metrics).
 */
import { connectSeat, createGame, startGame } from "./lib/probe.mjs";
import { isMain, line, option, record } from "./lib/report.mjs";
import { summarise } from "./lib/stats.mjs";

export const TARGET_P95_MS = 150;

export async function measureOrderRtt(origin, { n = 50, gapMs = 120 } = {}) {
  const game = await createGame(origin, { humans: 1, settings: { pacing: "async" }, stem: "Round trip probe" });
  await startGame(origin, game);
  const seat = await connectSeat(origin, game.gameId, game.seats[0].token);
  // The welcome may still be the lobby's; wait for the first movement phase to accept orders.
  let phase = seat.welcome.p.phase;
  let state = seat.welcome.p.state;
  if (seat.welcome.p.status !== "active") {
    const s = await seat.next("state", (f) => f.p.status === "active");
    phase = s.p.phase;
    state = s.p.state;
  }
  const holds = (state.units[seat.welcome.p.power] ?? []).map((unit) => `${unit} H`);
  const times = [];
  try {
    for (let i = 0; i < n; i++) {
      const id = `rtt-${i}`;
      const answer = seat.next(["orders.ack", "error"], (f) => f.id === id);
      const sent = performance.now();
      seat.send({ t: "orders.set", id, p: { phase, orders: holds } });
      const frame = await answer;
      if (frame.t === "error") throw new Error(`orders.set refused: ${frame.p.code} ${frame.p.message}`);
      times.push(performance.now() - sent);
      await new Promise((r) => setTimeout(r, gapMs));
    }
  } finally {
    seat.close();
  }
  return { gameId: game.gameId, phase, ...summarise(times) };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const origin = args.find((a) => /^https?:\/\//.test(a));
  if (!origin) {
    console.error("usage: node tools/metrics/order-rtt.mjs <origin> [--n 50] [--gap 120] [--record <where>]");
    process.exit(2);
  }
  const result = await measureOrderRtt(origin, { n: Number(option(args, "n", "50")), gapMs: Number(option(args, "gap", "120")) });
  console.log(JSON.stringify({ origin, ...result }));
  const pass = result.p95 !== null && result.p95 < TARGET_P95_MS;
  const where = option(args, "record", null);
  if (where) {
    record(line({ id: "order_rtt", value: `p95 ${result.p95} ms (p50 ${result.p50}, p99 ${result.p99}, n ${result.n})`, pass, where, detail: { origin, ...result } }));
  }
  process.exitCode = pass ? 0 : 1;
}

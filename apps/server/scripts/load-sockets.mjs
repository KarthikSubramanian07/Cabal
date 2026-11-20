#!/usr/bin/env node
/** Open N spectators plus the creator and measure an ALL-press broadcast. */
import { connectSeat, createGame, socketUrl, startGame } from "../../../tools/metrics/lib/probe.mjs";
import { percentile as rank } from "../../../tools/metrics/lib/stats.mjs";

const origin = process.argv[2];
const socketCount = Number(process.argv[3] ?? 200);
if (!origin || !Number.isInteger(socketCount) || socketCount < 1 || socketCount > 201) {
  console.error("usage: node scripts/load-sockets.mjs <http(s)://server> [socket-count<=201]");
  process.exit(2);
}

// The create, start and connect preamble is the phase 1 probes' own (tools/metrics/lib/probe.mjs).
const game = await createGame(origin, { humans: 1, settings: { press: "full" }, stem: "Load probe" });
await startGame(origin, game);
const { gameId, token } = { gameId: game.gameId, token: game.seats[0].token };
const wsUrl = socketUrl(origin, gameId);
// Spectator sockets open without a hello; the creator binds its seat with one (connectSeat).
const connect = async (asCreator) => {
  if (asCreator) return (await connectSeat(origin, gameId, token)).ws;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error("socket connect timeout")), 15_000);
    socket.addEventListener("open", () => (clearTimeout(timer), resolve(socket)), { once: true });
    socket.addEventListener("error", () => (clearTimeout(timer), reject(new Error("socket connect failed"))), { once: true });
  });
};

// The creator binds first so it does not count against the 200 spectator sockets.
const creator = await connect(true);
const clients = [creator, ...(await Promise.all(Array.from({ length: socketCount - 1 }, () => connect(false))))];
const arrivals = [];
const broadcastAt = Date.now();
const timeout = setTimeout(() => {
  for (const socket of clients) socket.close();
  console.error(`broadcast timed out: ${arrivals.length}/${socketCount}`);
  process.exit(1);
}, 30_000);
for (const socket of clients) {
  socket.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(String(event.data));
      if (frame.t === "press" && frame.p.body === "Cabal socket load probe") arrivals.push(Date.now() - broadcastAt);
    } catch {
      // Other frames are welcome/state snapshots and do not affect the measurement.
    }
  });
}
clients[0].send(JSON.stringify({ t: "press.send", p: { to: "ALL", body: "Cabal socket load probe" } }));
while (arrivals.length < socketCount && Date.now() - broadcastAt < 30_000) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
clearTimeout(timeout);
for (const socket of clients) socket.close();
arrivals.sort((a, b) => a - b);
const percentile = (fraction) => rank(arrivals, fraction);
console.log(JSON.stringify({
  gameId,
  sockets: socketCount,
  received: arrivals.length,
  p50Ms: percentile(0.5) ?? null,
  p95Ms: percentile(0.95) ?? null,
  maxMs: arrivals.at(-1) ?? null,
}));
if (arrivals.length !== socketCount) process.exitCode = 1;

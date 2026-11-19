#!/usr/bin/env node
/** Open N spectators plus the creator and measure an ALL-press broadcast. */
const origin = process.argv[2];
const socketCount = Number(process.argv[3] ?? 200);
if (!origin || !Number.isInteger(socketCount) || socketCount < 1 || socketCount > 201) {
  console.error("usage: node scripts/load-sockets.mjs <http(s)://server> [socket-count<=201]");
  process.exit(2);
}

const api = (path) => new URL(path, origin).toString();
const created = await fetch(api("/api/games"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Load probe", settings: { aiFill: true, press: "full" } }),
});
if (!created.ok) throw new Error(`create failed: ${created.status} ${await created.text()}`);
const { gameId, token } = await created.json();
const started = await fetch(api(`/api/games/${gameId}/start`), {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
if (!started.ok) throw new Error(`start failed: ${started.status} ${await started.text()}`);

const socketOrigin = new URL(origin);
socketOrigin.protocol = socketOrigin.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = new URL(`/api/games/${gameId}/ws`, socketOrigin);
const sockets = [];
// Every socket opens as a spectator. The creator then binds its seat with a hello frame: the
// token never goes in the URL.
const connect = (asCreator) => new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl);
  const timer = setTimeout(() => reject(new Error("socket connect timeout")), 15_000);
  const done = () => {
    clearTimeout(timer);
    sockets.push(socket);
    resolve(socket);
  };
  socket.addEventListener("open", () => {
    if (!asCreator) return done();
    socket.send(JSON.stringify({ t: "hello", p: { token } }));
    socket.addEventListener("message", function bound(event) {
      const frame = JSON.parse(String(event.data));
      if (frame.t === "welcome" && frame.p.power !== null) {
        socket.removeEventListener("message", bound);
        done();
      }
    });
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("socket connect failed"));
  }, { once: true });
});

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
const percentile = (fraction) => arrivals[Math.max(0, Math.ceil(arrivals.length * fraction) - 1)];
console.log(JSON.stringify({
  gameId,
  sockets: socketCount,
  received: arrivals.length,
  p50Ms: percentile(0.5) ?? null,
  p95Ms: percentile(0.95) ?? null,
  maxMs: arrivals.at(-1) ?? null,
}));
if (arrivals.length !== socketCount) process.exitCode = 1;

/**
 * The preamble every probe of a running server shares: make a game over the public HTTP API,
 * seat players, start it, and open seat sockets that bind with a `hello` frame (a seat token never
 * travels in a URL). Plain `fetch` and the platform `WebSocket` (Node 22 and later), no package.
 * Used by order-rtt.mjs, full-game.mjs and apps/server/scripts/load-sockets.mjs.
 */

/** `https://host` to `wss://host/api/games/:id/ws`. */
export function socketUrl(origin, gameId) {
  const url = new URL(`/api/games/${gameId}/ws`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function post(origin, path, body, token) {
  const res = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** A game with `humans` seated players (named `stem 1`, `stem 2`...) and the rest left to AI fill. */
export async function createGame(origin, { humans = 1, settings = {}, stem = "Probe" } = {}) {
  const made = await post(origin, "/api/games", { name: `${stem} 1`, settings: { aiFill: true, visibility: "unlisted", ...settings } });
  const seats = [{ gameId: made.gameId, power: made.power, token: made.token }];
  for (let i = 2; i <= humans; i++) {
    const joined = await post(origin, `/api/games/${made.gameId}/join`, { name: `${stem} ${i}` });
    seats.push({ gameId: joined.gameId, power: joined.power, token: joined.token });
  }
  return { gameId: made.gameId, seats };
}

/** Start a lobby as its creator (the first seat). */
export async function startGame(origin, game) {
  await post(origin, `/api/games/${game.gameId}/start`, {}, game.seats[0].token);
}

/**
 * A seat's socket, bound with `hello`. `frames` is every frame received; `next(type, test)` waits
 * for the next frame of a type, or of any of a list of types (and passing `test`), from now on;
 * `send` writes one.
 */
export function connectSeat(origin, gameId, token, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl(origin, gameId));
    const waiters = new Set();
    const frames = [];
    const timer = setTimeout(() => reject(new Error("no welcome in time")), timeoutMs);
    const seat = {
      ws,
      frames,
      welcome: null,
      send: (frame) => ws.send(JSON.stringify(frame)),
      next(type, test = () => true, ms = timeoutMs) {
        return new Promise((done, fail) => {
          const waiter = { type, test, done, timer: setTimeout(() => (waiters.delete(waiter), fail(new Error(`no ${type} frame in ${ms} ms`))), ms) };
          waiters.add(waiter);
        });
      },
      close: () => ws.close(),
    };
    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      frames.push(frame);
      if (frame.t === "welcome" && frame.p?.power && !seat.welcome) {
        seat.welcome = frame;
        clearTimeout(timer);
        resolve(seat);
      }
      for (const w of [...waiters]) {
        if ((Array.isArray(w.type) ? w.type.includes(frame.t) : w.type === frame.t) && w.test(frame)) {
          waiters.delete(w);
          clearTimeout(w.timer);
          w.done(frame);
        }
      }
    });
    ws.addEventListener("open", () => seat.send({ t: "hello", p: { token } }), { once: true });
    ws.addEventListener("error", () => (clearTimeout(timer), reject(new Error("socket failed"))), { once: true });
    ws.addEventListener("close", (event) => {
      if (!seat.welcome) (clearTimeout(timer), reject(new Error(`socket closed before its welcome: ${event.code} ${event.reason}`)));
    });
  });
}

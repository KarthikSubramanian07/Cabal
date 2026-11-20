/**
 * The browser's way to the game server. Everything goes to this origin: in production the Pages
 * worker hands `/api` to the server over a service binding, and `vite dev` and `vite preview`
 * proxy it to a local `wrangler dev` (vite.config.ts). The CSP can therefore stay `connect-src 'self'`.
 *
 * The calls and the socket are the protocol package's own (`@cabal/protocol/client`), so every
 * response and every frame is checked against the same zod schemas the server is tested with.
 */
import { ApiError, CabalSocket, type SocketLike, createApi } from "@cabal/protocol/client";
import { timings } from "./timings.js";

export const api = createApi({ baseUrl: "" });

/** `ws://` or `wss://` to this origin's socket route for one game. */
export function socketUrl(gameId: string, location: Pick<Location, "protocol" | "host"> = window.location): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/games/${encodeURIComponent(gameId)}/ws`;
}

/**
 * A socket to one game: a spectator without a token, the token's seat with one. A seat's socket
 * also times the phase 1 metrics (net/timings.ts): each order's round trip, and the first game
 * accepting orders after a visit that opened at the front page.
 */
export function openSocket(gameId: string, token?: string): CabalSocket {
  const socket = new CabalSocket({
    connect: () => new WebSocket(socketUrl(gameId)) as unknown as SocketLike,
    ...(token ? { token, onReply: timings.noteReply } : {}),
  });
  if (token) socket.on("frame", (frame) => timings.noteFrame(frame));
  return socket;
}

export { failureText } from "./failure.js";

export { ApiError };

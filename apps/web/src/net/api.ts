/**
 * The browser's way to the game server. Everything goes to this origin: in production the Pages
 * worker hands `/api` to the server over a service binding, and `vite dev` and `vite preview`
 * proxy it to a local `wrangler dev` (vite.config.ts). The CSP can therefore stay `connect-src 'self'`.
 *
 * The calls and the socket are the protocol package's own (`@cabal/protocol/client`), so every
 * response and every frame is checked against the same zod schemas the server is tested with.
 */
import { ApiError, CabalSocket, type SocketLike, createApi } from "@cabal/protocol/client";

export const api = createApi({ baseUrl: "" });

/** `ws://` or `wss://` to this origin's socket route for one game. */
export function socketUrl(gameId: string, location: Pick<Location, "protocol" | "host"> = window.location): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/games/${encodeURIComponent(gameId)}/ws`;
}

/** A socket to one game: a spectator without a token, the token's seat with one. */
export function openSocket(gameId: string, token?: string): CabalSocket {
  return new CabalSocket({
    connect: () => new WebSocket(socketUrl(gameId)) as unknown as SocketLike,
    ...(token ? { token } : {}),
  });
}

export { failureText } from "./failure.js";

export { ApiError };

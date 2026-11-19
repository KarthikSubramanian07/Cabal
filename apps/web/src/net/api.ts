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

/**
 * What to tell a person when a call fails. The server's own messages are written for people
 * ("no open seats", "game already started"); a network failure is said plainly.
 */
export function failureText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "Too many tries in a minute. Wait a moment and try again.";
    if (error.status >= 500) return "The game server could not answer. Try again in a moment.";
    return sentence(error.message);
  }
  return "The game server cannot be reached. Check your connection and try again.";
}

function sentence(text: string): string {
  const t = text.trim();
  if (t === "") return "Something went wrong.";
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

export { ApiError };

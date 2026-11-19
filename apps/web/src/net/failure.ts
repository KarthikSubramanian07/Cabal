/**
 * What to tell a person when a call to the game server fails. Kept apart from the API client
 * (api.ts), which carries the protocol's schemas, so the front door and the player menu can say
 * it without loading them: the client is fetched only when a call is actually made (lazy.ts).
 */

/** The parts of `ApiError` (@cabal/protocol/client) this reads; checked by shape, not by class. */
export interface ApiFailure {
  name: "ApiError";
  status: number;
  message: string;
  body: unknown;
}

export function isApiFailure(error: unknown): error is ApiFailure {
  return error instanceof Error && error.name === "ApiError" && typeof (error as { status?: unknown }).status === "number";
}

/** The machine-readable `code` a refusal carries, when it has one. */
export function failureCode(error: unknown): string | null {
  if (!isApiFailure(error)) return null;
  const code = (error.body as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * The server's own messages are written for people ("no open seats", "game already started");
 * a network failure is said plainly.
 */
export function failureText(error: unknown): string {
  if (isApiFailure(error)) {
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

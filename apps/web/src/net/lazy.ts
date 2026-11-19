/**
 * The API client, fetched the first time something calls the server. The front door and the
 * shell's player menu reach the server only when a person acts, so the protocol's schemas stay
 * out of the first load.
 */
let loading: Promise<typeof import("./api.js")> | null = null;

export function loadApi(): Promise<typeof import("./api.js")> {
  loading ??= import("./api.js");
  return loading;
}

/** A refusal made on this side, shaped like the client's own so callers treat both alike. */
export function localRefusal(status: number, message: string): Error {
  const error = new Error(message) as Error & { status: number; body: unknown };
  error.name = "ApiError";
  error.status = status;
  error.body = null;
  return error;
}

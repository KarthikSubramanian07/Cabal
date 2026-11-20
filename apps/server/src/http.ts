/** Small HTTP helpers shared by the routes: JSON answers, CORS, bounded bodies and rate limits. */

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  // So a client can quote the id of a request that went wrong.
  "access-control-expose-headers": "x-request-id",
};

/** Request bodies are small JSON objects; anything larger is refused before parsing. */
const MAX_BODY_BYTES = 4096;

export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  headers.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: res.status, headers, webSocket: res.webSocket ?? null });
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** The body as JSON, or undefined when it is not JSON or is longer than `max` bytes. */
export async function readJson(request: Request, max = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > max) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text || "{}");
  } catch {
    return undefined;
  }
}

/** True when the caller is over the limit. Missing bindings (tests, local dev) never limit. */
export async function limited(limiter: RateLimit | undefined, request: Request, route: string): Promise<boolean> {
  if (!limiter) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${route}:${ip}` });
  return !success;
}

/** True when `key` (a player, a game) is over the limit. Missing bindings never limit. */
export async function limitedKey(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  return !(await limiter.limit({ key })).success;
}

export const tooMany = () => withCors(json({ error: "too many requests, try again in a minute" }, 429));


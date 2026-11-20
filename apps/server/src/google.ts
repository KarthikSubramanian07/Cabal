/**
 * Sign in with Google: checking the ID token Google's button hands the browser.
 *
 * The browser gets a signed JWT from Google Identity Services and posts it here. Nothing else
 * from Google is needed (no client secret, no redirect): the token is checked against Google's
 * published keys, its audience must be this deployment's client ID, its issuer Google, and it
 * must not have expired. Only the token's `sub` (Google's stable id for the account) is used, and
 * only its hash is stored: Cabal keeps no email address and no name.
 */
import { hashToken } from "./tokens.js";

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
/** Clock difference tolerated between Google and this Worker. */
const SKEW_S = 60;
/** How long Google's keys are kept when its answer names no max-age. */
const DEFAULT_KEYS_TTL_MS = 60 * 60 * 1000;

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

let cachedKeys: { keys: Map<string, CryptoKey>; until: number } | null = null;

/** For tests: forget the keys fetched so far. */
export function forgetGoogleKeys(): void {
  cachedKeys = null;
}

async function googleKeys(now: number, fetcher: typeof fetch, refresh = false): Promise<Map<string, CryptoKey>> {
  if (cachedKeys && cachedKeys.until > now && !refresh) return cachedKeys.keys;
  const res = await fetcher(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error(`Google's keys answered ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
  cachedKeys = { keys, until: now + (maxAge ? Number(maxAge) * 1000 : DEFAULT_KEYS_TTL_MS) };
  return keys;
}

function base64UrlBytes(part: string): Uint8Array {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why a token was turned away, for the logs (never shown with the token itself). */
export type GoogleRefusal = "malformed" | "unknown_key" | "bad_signature" | "wrong_audience" | "wrong_issuer" | "expired" | "no_subject";

/**
 * The Google account a token proves, or why it does not. `now` is in milliseconds.
 * Throws only when Google's keys cannot be fetched.
 */
export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; subject: string } | { ok: false; reason: GoogleRefusal }> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "malformed" };
  const header = base64UrlJson(parts[0]!);
  const claims = base64UrlJson(parts[1]!);
  if (!header || !claims || header["alg"] !== "RS256" || typeof header["kid"] !== "string") return { ok: false, reason: "malformed" };

  let keys = await googleKeys(now, fetcher);
  let key = keys.get(header["kid"]);
  // Google rotates its keys; a kid we have not seen may be a new one.
  if (!key) {
    keys = await googleKeys(now, fetcher, true);
    key = keys.get(header["kid"]);
  }
  if (!key) return { ok: false, reason: "unknown_key" };

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]!), signed);
  if (!valid) return { ok: false, reason: "bad_signature" };

  const audience = claims["aud"];
  if (!(audience === clientId || (Array.isArray(audience) && audience.includes(clientId)))) return { ok: false, reason: "wrong_audience" };
  if (typeof claims["iss"] !== "string" || !ISSUERS.has(claims["iss"])) return { ok: false, reason: "wrong_issuer" };
  const seconds = now / 1000;
  if (typeof claims["exp"] !== "number" || claims["exp"] + SKEW_S < seconds) return { ok: false, reason: "expired" };
  if (typeof claims["iat"] === "number" && claims["iat"] - SKEW_S > seconds) return { ok: false, reason: "expired" };
  if (typeof claims["sub"] !== "string" || claims["sub"].length === 0) return { ok: false, reason: "no_subject" };
  return { ok: true, subject: claims["sub"] };
}

/** What is stored for a Google account: a hash of its id, never the id, an email or a name. */
export const googleSubjectKey = (subject: string) => hashToken(`google:${subject}`);

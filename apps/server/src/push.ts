/**
 * Web Push from a Worker, with Web Crypto and nothing else: no npm `web-push` (it needs Node's
 * `crypto` and `https`, which workerd does not have).
 *
 *  - Message encryption is RFC 8291 over RFC 8188 `aes128gcm`: an ephemeral P-256 key agreement
 *    with the browser's subscription key, mixed with its 16-byte auth secret through HKDF, then
 *    one AES-128-GCM record. The test suite checks the result byte for byte against RFC 8291's
 *    worked example.
 *  - The application server identifies itself with VAPID (RFC 8292): an ES256 JWT for the push
 *    service's origin, signed with the deployment's private key, sent with the public key.
 *
 * Keys travel as base64url: the public key as the 65-byte uncompressed point (what a browser
 * passes as `applicationServerKey`), the private key as its 32-byte scalar `d`.
 */

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode base64url (or plain base64, padded or not). Throws on anything else. */
export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9_+/-]*={0,2}$/.test(clean)) throw new Error("not base64url");
  const b64 = clean.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

/** A P-256 public key as the 65-byte uncompressed point, or null when it is not one. */
export function p256Point(text: string): Uint8Array | null {
  try {
    const bytes = fromBase64Url(text);
    return bytes.byteLength === 65 && bytes[0] === 0x04 ? bytes : null;
  } catch {
    return null;
  }
}

/** A JWK for a P-256 key from its uncompressed public point and, for a private key, its scalar. */
function jwk(publicPoint: Uint8Array, d?: Uint8Array): JsonWebKey {
  return {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(publicPoint.slice(1, 33)),
    y: toBase64Url(publicPoint.slice(33, 65)),
    ...(d ? { d: toBase64Url(d) } : {}),
    ext: true,
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** The record size every message declares; one record holds any payload this server sends. */
export const RECORD_SIZE = 4096;
/** Push services accept 4096 bytes of body; the header and tag take 103, so stay well inside. */
export const MAX_PAYLOAD_BYTES = 3072;

export interface ServerKeyPair {
  privateKey: CryptoKey;
  /** The 65-byte uncompressed public point. */
  publicPoint: Uint8Array;
}

/** A fresh ECDH key pair for one message: the "as" key of RFC 8291. */
export async function ephemeralKeys(): Promise<ServerKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicPoint: new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer) };
}

/** Rebuild a known ECDH key pair; only RFC 8291's test vector needs this. */
export async function importServerKeys(publicPoint: Uint8Array, d: Uint8Array): Promise<ServerKeyPair> {
  const privateKey = await crypto.subtle.importKey("jwk", jwk(publicPoint, d), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey, publicPoint };
}

/**
 * Encrypt `plaintext` for one subscription as an `aes128gcm` body (RFC 8291 section 3.4).
 * `uaPublic` is the subscription's `p256dh` (65 bytes), `authSecret` its `auth` (16 bytes).
 * `salt` and `serverKeys` are random unless given; only the RFC test vector gives them.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  fixed: { salt?: Uint8Array; serverKeys?: ServerKeyPair } = {},
): Promise<Uint8Array> {
  if (uaPublic.byteLength !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh must be a 65-byte uncompressed P-256 point");
  if (authSecret.byteLength !== 16) throw new Error("auth must be 16 bytes");
  if (plaintext.byteLength > MAX_PAYLOAD_BYTES) throw new Error(`push payloads are at most ${MAX_PAYLOAD_BYTES} bytes`);
  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const as = fixed.serverKeys ?? (await ephemeralKeys());
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The Workers type definitions spell the spec's `public` member `$public`; the runtime wants `public`.
  const agreement = { name: "ECDH", public: ua } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(agreement, as.privateKey, 256));
  // Combine the shared secret with the auth secret: IKM = HKDF(auth, ecdh, "WebPush: info" 0 ua as).
  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, as.publicPoint);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  // RFC 8188: the content encryption key and nonce.
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record, so it is the last: the padding delimiter is 0x02 and no padding follows.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, concat(plaintext, Uint8Array.of(2))));
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = 65;
  header.set(as.publicPoint, 21);
  return concat(header, sealed);
}

// ---------- VAPID (RFC 8292) ----------

export interface VapidKeys {
  /** base64url, 65-byte uncompressed point: what the browser gets as `applicationServerKey`. */
  publicKey: string;
  /** base64url, the 32-byte private scalar. A Worker secret, never in config. */
  privateKey: string;
  /** Who runs this server, for the push service: an `https:` URL or a `mailto:` address. */
  subject: string;
}

/** A JWT is good for at most a day (RFC 8292 section 2); ask for twelve hours and renew after eleven. */
const JWT_LIFETIME_S = 12 * 3600;
const JWT_RENEW_S = 3600;

const signers = new Map<string, Promise<CryptoKey>>();
const tokens = new Map<string, { jwt: string; exp: number }>();

function signer(keys: VapidKeys): Promise<CryptoKey> {
  let key = signers.get(keys.privateKey);
  if (!key) {
    const point = p256Point(keys.publicKey);
    if (!point) throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point, base64url");
    const d = fromBase64Url(keys.privateKey);
    if (d.byteLength !== 32) throw new Error("VAPID private key must be 32 bytes, base64url");
    key = crypto.subtle.importKey("jwk", jwk(point, d), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    // A key that does not import (it does not match the public key) is not cached.
    key.catch(() => signers.delete(keys.privateKey));
    signers.set(keys.privateKey, key);
  }
  return key;
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for a push endpoint. Cached per push service. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, nowMs: number): Promise<string> {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(nowMs / 1000);
  const cacheKey = `${keys.publicKey}|${aud}|${keys.subject}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.exp - now > JWT_RENEW_S) return `vapid t=${cached.jwt}, k=${keys.publicKey}`;
  const exp = now + JWT_LIFETIME_S;
  const part = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud, exp, sub: keys.subject })}`;
  // Web Crypto signs ECDSA in the IEEE P1363 form (r then s, 64 bytes), which is what JWS wants.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signer(keys), encoder.encode(unsigned)));
  const jwt = `${unsigned}.${toBase64Url(signature)}`;
  tokens.set(cacheKey, { jwt, exp });
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

// ---------- sending ----------

export interface PushTarget {
  endpoint: string;
  /** base64url, the subscription's `keys.p256dh`. */
  p256dh: string;
  /** base64url, the subscription's `keys.auth`. */
  auth: string;
}

export interface PushOptions {
  /** Seconds the push service may hold the message for an offline device. */
  ttl: number;
  urgency: "very-low" | "low" | "normal" | "high";
  /** Replaces an undelivered message with the same topic: at most 32 base64url characters. */
  topic?: string;
}

/** A topic the push service will accept: base64url characters only, at most 32 of them. */
export function pushTopic(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

/** Build the request that delivers `payload` to one subscription. */
export async function pushRequest(target: PushTarget, payload: unknown, options: PushOptions, keys: VapidKeys, nowMs: number): Promise<Request> {
  const uaPublic = p256Point(target.p256dh);
  if (!uaPublic) throw new Error("subscription p256dh is not a P-256 point");
  const body = await encryptPayload(encoder.encode(JSON.stringify(payload)), uaPublic, fromBase64Url(target.auth));
  const headers: Record<string, string> = {
    authorization: await vapidAuthorization(target.endpoint, keys, nowMs),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(Math.max(0, Math.floor(options.ttl))),
    urgency: options.urgency,
  };
  const topic = options.topic ? pushTopic(options.topic) : "";
  if (topic) headers.topic = topic;
  return new Request(target.endpoint, { method: "POST", headers, body });
}

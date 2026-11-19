/** A browser's side of Web Push, for tests: its keys, and reading back what the server sent it. */
import { expect } from "vitest";
import { fromBase64Url, toBase64Url } from "../src/push.js";

export const bytes = (text: string) => new TextEncoder().encode(text);

/** The browser's side of RFC 8291, written out independently, to read back what the server sent. */
export async function decrypt(body: Uint8Array, uaPublic: Uint8Array, uaPrivate: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  expect(rs).toBe(4096);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  const jwk = { kty: "EC", crv: "P-256", x: toBase64Url(uaPublic.slice(1, 33)), y: toBase64Url(uaPublic.slice(33)), d: toBase64Url(uaPrivate) };
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm, priv, 256));
  const hmac = async (key: Uint8Array, data: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));
  const one = Uint8Array.of(1);
  const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
  const prkKey = await hmac(auth, ecdh);
  const ikm = await hmac(prkKey, join(bytes("WebPush: info\0"), uaPublic, asPublic, one));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, join(bytes("Content-Encoding: aes128gcm\0"), one))).slice(0, 16);
  const nonce = (await hmac(prk, join(bytes("Content-Encoding: nonce\0"), one))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
  expect(padded.at(-1)).toBe(2);
  return new TextDecoder().decode(padded.slice(0, -1));
}

export async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicPoint = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const d = fromBase64Url(((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey).d!);
  return { publicPoint, d, auth: crypto.getRandomValues(new Uint8Array(16)) };
}

export async function vapidKeys(subject = "https://playcabal.pages.dev") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
  const privateKey = ((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey).d!;
  return { publicKey, privateKey, subject, verifyKey: pair.publicKey };
}


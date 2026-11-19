/** Web Push encryption (RFC 8291) and VAPID (RFC 8292) with nothing but Web Crypto. */
import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  encryptPayload,
  fromBase64Url,
  importServerKeys,
  pushRequest,
  pushTopic,
  toBase64Url,
  vapidAuthorization,
} from "../src/push.js";
import { browserKeys, bytes, decrypt, vapidKeys } from "./push-helpers.js";

/** RFC 8291 appendix A and section 5, whitespace removed. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("RFC 8291 message encryption", () => {
  it("reproduces the RFC's worked example byte for byte", async () => {
    const serverKeys = await importServerKeys(fromBase64Url(RFC.asPublic), fromBase64Url(RFC.asPrivate));
    const body = await encryptPayload(bytes(RFC.plaintext), fromBase64Url(RFC.uaPublic), fromBase64Url(RFC.auth), { salt: fromBase64Url(RFC.salt), serverKeys });
    // 86 bytes of header, 41 of text, the delimiter and a 16-byte tag. (The example's
    // `Content-Length: 145` is one too many: the body it prints is 192 base64url characters.)
    expect(body.byteLength).toBe(144);
    expect(toBase64Url(body)).toBe(RFC.body);
  });

  it("the browser's side of the RFC reads the example back", async () => {
    const text = await decrypt(fromBase64Url(RFC.body), fromBase64Url(RFC.uaPublic), fromBase64Url(RFC.uaPrivate), fromBase64Url(RFC.auth));
    expect(text).toBe(RFC.plaintext);
  });

  it("uses a fresh key and salt every time, and a browser can always read it", async () => {
    const ua = await browserKeys();
    const a = await encryptPayload(bytes("Orders due"), ua.publicPoint, ua.auth);
    const b = await encryptPayload(bytes("Orders due"), ua.publicPoint, ua.auth);
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
    expect(toBase64Url(a.slice(0, 16))).not.toBe(toBase64Url(b.slice(0, 16)));
    expect(await decrypt(a, ua.publicPoint, ua.d, ua.auth)).toBe("Orders due");
    expect(await decrypt(b, ua.publicPoint, ua.d, ua.auth)).toBe("Orders due");
  });

  it("refuses keys of the wrong shape and payloads too big for one record", async () => {
    const ua = await browserKeys();
    await expect(encryptPayload(bytes("x"), ua.publicPoint.slice(1), ua.auth)).rejects.toThrow(/p256dh/);
    await expect(encryptPayload(bytes("x"), ua.publicPoint, ua.auth.slice(1))).rejects.toThrow(/auth/);
    await expect(encryptPayload(new Uint8Array(MAX_PAYLOAD_BYTES + 1), ua.publicPoint, ua.auth)).rejects.toThrow(/at most/);
  });
});

describe("VAPID", () => {
  it("signs an ES256 JWT for the push service's origin that verifies with the public key", async () => {
    const keys = await vapidKeys();
    const now = Date.UTC(2026, 10, 19, 12);
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc:def", keys, now);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(match[2]).toBe(keys.publicKey);
    const [h, c, s] = match[1]!.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(c!))) as { aud: string; exp: number; sub: string };
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://playcabal.pages.dev" });
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.verifyKey, fromBase64Url(s!), bytes(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it("reuses a token for the same push service and renews it in its last hour", async () => {
    const keys = await vapidKeys();
    const now = Date.UTC(2026, 10, 19, 12);
    const first = await vapidAuthorization("https://updates.push.services.mozilla.com/wpush/v2/a", keys, now);
    expect(await vapidAuthorization("https://updates.push.services.mozilla.com/wpush/v2/b", keys, now + 10 * 3600_000)).toBe(first);
    expect(await vapidAuthorization("https://updates.push.services.mozilla.com/wpush/v2/c", keys, now + 11.5 * 3600_000)).not.toBe(first);
    expect(await vapidAuthorization("https://web.push.apple.com/abc", keys, now)).not.toBe(first);
  });

  it("refuses a key pair that is not a P-256 pair", async () => {
    const keys = await vapidKeys();
    await expect(vapidAuthorization("https://fcm.googleapis.com/x", { ...keys, publicKey: "AAAA" }, Date.now())).rejects.toThrow(/public key/);
    await expect(vapidAuthorization("https://fcm.googleapis.com/x", { ...keys, privateKey: "AAAA" }, Date.now())).rejects.toThrow(/private key/);
  });
});

describe("the push request", () => {
  it("carries the encrypted body and the headers a push service wants", async () => {
    const keys = await vapidKeys();
    const ua = await browserKeys();
    const target = { endpoint: "https://fcm.googleapis.com/fcm/send/xyz", p256dh: toBase64Url(ua.publicPoint), auth: toBase64Url(ua.auth) };
    const request = await pushRequest(target, { title: "Orders due" }, { ttl: 600.7, urgency: "high", topic: "K7Q2AB deadline!" }, keys, Date.now());
    expect(request.method).toBe("POST");
    expect(request.url).toBe(target.endpoint);
    expect(request.headers.get("content-encoding")).toBe("aes128gcm");
    expect(request.headers.get("ttl")).toBe("600");
    expect(request.headers.get("urgency")).toBe("high");
    expect(request.headers.get("topic")).toBe("K7Q2ABdeadline");
    expect(request.headers.get("authorization")).toMatch(/^vapid t=.+, k=/);
    const body = new Uint8Array(await request.arrayBuffer());
    expect(JSON.parse(await decrypt(body, ua.publicPoint, ua.d, ua.auth))).toEqual({ title: "Orders due" });
  });

  it("keeps topics to what the protocol allows", () => {
    expect(pushTopic("ABC123-press-FRANCE")).toBe("ABC123-press-FRANCE");
    expect(pushTopic("a b/c+d=")).toBe("abcd");
    expect(pushTopic("x".repeat(40))).toHaveLength(32);
  });
});

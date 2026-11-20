/** Sign in with Google: checking Google's ID token, and the account it opens, links or makes. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GoogleConfigResponse, GoogleSignInResponse, MeResponse } from "@cabal/protocol";
import { GOOGLE_CERTS_URL, forgetGoogleKeys, googleSubjectKey, verifyGoogleIdToken } from "../src/google.js";
import { playerRoute } from "../src/players.js";
import { call, newPlayer, nextIp, serverEnv } from "./helpers.js";

const CLIENT = "1234-test.apps.googleusercontent.com";
const KID = "test-key-1";
let keys: CryptoKeyPair;
let jwk: JsonWebKey;

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function token(claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey } = {}): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: opts.kid ?? KID, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const now = () => Date.now();
const claimsFor = (sub: string, extra: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT,
  sub,
  iat: Math.floor(now() / 1000) - 10,
  exp: Math.floor(now() / 1000) + 3600,
  email: "someone@example.com",
  name: "Some One",
  ...extra,
});

/** Google's keys endpoint, as a fetch the code under test can be handed. */
const certs = vi.fn(async (input: RequestInfo | URL) => {
  expect(String(input)).toBe(GOOGLE_CERTS_URL);
  return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=20000" },
  });
}) as unknown as typeof fetch;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
});

afterEach(() => {
  forgetGoogleKeys();
  vi.unstubAllGlobals();
});

describe("checking Google's ID token", () => {
  it("accepts a token Google signed for this client, and gives its account id", async () => {
    const result = await verifyGoogleIdToken(await token(claimsFor("1001")), CLIENT, now(), certs);
    expect(result).toEqual({ ok: true, subject: "1001" });
  });

  it("refuses another client's token, another issuer, an expired one, and one signed by anyone else", async () => {
    const check = async (t: string) => verifyGoogleIdToken(t, CLIENT, now(), certs);
    expect(await check(await token(claimsFor("1", { aud: "someone-else.apps.googleusercontent.com" })))).toEqual({ ok: false, reason: "wrong_audience" });
    expect(await check(await token(claimsFor("1", { iss: "https://evil.example" })))).toEqual({ ok: false, reason: "wrong_issuer" });
    expect(await check(await token(claimsFor("1", { exp: Math.floor(now() / 1000) - 3600 })))).toEqual({ ok: false, reason: "expired" });
    expect(await check(await token(claimsFor("1", { sub: "" })))).toEqual({ ok: false, reason: "no_subject" });
    const stranger = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    expect(await check(await token(claimsFor("1"), { key: stranger.privateKey }))).toEqual({ ok: false, reason: "bad_signature" });
    expect(await check(await token(claimsFor("1"), { kid: "nobody-knows" }))).toEqual({ ok: false, reason: "unknown_key" });
    expect(await check("not.a.token")).toEqual({ ok: false, reason: "malformed" });
    // A claims body edited after signing no longer matches the signature.
    const [h, , s] = (await token(claimsFor("1"))).split(".");
    expect(await check(`${h}.${b64url(JSON.stringify(claimsFor("2")))}.${s}`)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("keeps Google's keys between checks, and asks again for a key it has not seen", async () => {
    const fetcher = vi.fn(certs);
    await verifyGoogleIdToken(await token(claimsFor("1")), CLIENT, now(), fetcher as unknown as typeof fetch);
    await verifyGoogleIdToken(await token(claimsFor("2")), CLIENT, now(), fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await verifyGoogleIdToken(await token(claimsFor("3"), { kid: "rotated" }), CLIENT, now(), fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

/** The route, run in this isolate with Google sign-in switched on and Google's keys stood in for. */
async function signIn(credential: string, secret?: string) {
  vi.stubGlobal("fetch", certs);
  const request = new Request("http://cabal/api/auth/google", {
    method: "POST",
    headers: { "cf-connecting-ip": nextIp(), ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ credential }),
  });
  const res = (await playerRoute(request, { ...serverEnv, GOOGLE_CLIENT_ID: CLIENT }, new URL(request.url)))!;
  vi.unstubAllGlobals();
  return res;
}

describe("signing in with Google", () => {
  it("hands the button this deployment's client ID", async () => {
    const config = GoogleConfigResponse.parse(await (await call("/api/auth/google", null)).json());
    expect(config.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
  });

  it("is off when no client ID is set: the button learns there is none, and a sign-in is refused", async () => {
    const off = { ...serverEnv, GOOGLE_CLIENT_ID: "" };
    const get = new Request("http://cabal/api/auth/google");
    expect(GoogleConfigResponse.parse(await (await playerRoute(get, off, new URL(get.url)))!.json())).toEqual({ clientId: null });
    const post = new Request("http://cabal/api/auth/google", {
      method: "POST",
      headers: { "cf-connecting-ip": nextIp() },
      body: JSON.stringify({ credential: "x".repeat(40) }),
    });
    const res = (await playerRoute(post, off, new URL(post.url)))!;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "google_off" });
  });

  it("makes a new account the first time, and opens the same one on every device after", async () => {
    const sub = `g-${crypto.randomUUID()}`;
    const first = await signIn(await token(claimsFor(sub)));
    expect(first.status).toBe(201);
    const made = GoogleSignInResponse.parse(await first.json());
    expect(made.outcome).toBe("created");
    expect(made.player.handle).toMatch(/^[A-Z][a-z]+-\d{4}$/);
    const again = GoogleSignInResponse.parse(await (await signIn(await token(claimsFor(sub)))).json());
    expect(again).toMatchObject({ outcome: "signed_in", player: made.player });
    expect(again.secret).not.toBe(made.secret);
    const me = MeResponse.parse(await (await call("/api/me", again.secret)).json());
    expect(me.account).toMatchObject({ google: true, sessions: 2 });
  });

  it("keeps only a hash of Google's account id: no email, no name, no id in the clear", async () => {
    const sub = `g-${crypto.randomUUID()}`;
    await signIn(await token(claimsFor(sub, { email: "private@example.com", name: "Private Person" })));
    const rows = JSON.stringify((await serverEnv.DB!.prepare("SELECT * FROM google_links").all()).results);
    expect(rows).toContain(googleSubjectKey(sub));
    expect(rows).not.toContain(sub);
    const players = JSON.stringify((await serverEnv.DB!.prepare("SELECT * FROM players").all()).results);
    expect(players).not.toContain("private@example.com");
    expect(players).not.toContain("Private Person");
  });

  it("links the account a device already holds, and then refuses a second Google account for it", async () => {
    const guest = await newPlayer();
    const linked = GoogleSignInResponse.parse(await (await signIn(await token(claimsFor(`g-${crypto.randomUUID()}`)), guest.secret)).json());
    expect(linked).toMatchObject({ outcome: "linked", player: guest.player });
    const second = await signIn(await token(claimsFor(`g-${crypto.randomUUID()}`)), guest.secret);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "google_taken" });
  });

  it("switches a device to the linked account when its Google account already has one", async () => {
    const sub = `g-${crypto.randomUUID()}`;
    const owner = GoogleSignInResponse.parse(await (await signIn(await token(claimsFor(sub)))).json());
    const other = await newPlayer();
    const res = GoogleSignInResponse.parse(await (await signIn(await token(claimsFor(sub)), other.secret)).json());
    expect(res).toMatchObject({ outcome: "signed_in", player: owner.player });
  });

  it("refuses a token Google did not sign for this client, and a dead device secret", async () => {
    const res = await signIn(await token(claimsFor("1", { aud: "someone-else" })));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "google_refused" });
    expect((await signIn(await token(claimsFor("1")), "cps_" + "0".repeat(48))).status).toBe(401);
  });

  it("unlinks on request, and deleting the account takes the link with it", async () => {
    const sub = `g-${crypto.randomUUID()}`;
    const made = GoogleSignInResponse.parse(await (await signIn(await token(claimsFor(sub)))).json());
    const after = MeResponse.parse(await (await call("/api/me/google", made.secret, { method: "DELETE" })).json());
    expect(after.account.google).toBe(false);
    // Unlinked, the same Google account makes a fresh account rather than opening the old one.
    const fresh = GoogleSignInResponse.parse(await (await signIn(await token(claimsFor(sub)))).json());
    expect(fresh.outcome).toBe("created");
    expect(fresh.player.id).not.toBe(made.player.id);
    const del = await call("/api/me", fresh.secret, { method: "DELETE", body: JSON.stringify({ handle: fresh.player.handle }) });
    expect(del.status).toBeLessThan(300);
    const left = await serverEnv.DB!.prepare("SELECT COUNT(*) AS n FROM google_links WHERE player_id = ?").bind(fresh.player.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

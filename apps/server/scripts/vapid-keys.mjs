#!/usr/bin/env node
/**
 * Make a VAPID key pair for Web Push (RFC 8292) with Web Crypto.
 *
 *   node scripts/vapid-keys.mjs <directory>
 *
 * Writes `vapid-public.txt` (the base64url 65-byte point, for VAPID_PUBLIC_KEY in wrangler.jsonc)
 * and `vapid-private.txt` (the base64url 32-byte scalar, readable by the owner only, for
 * `wrangler secret put VAPID_PRIVATE_KEY < vapid-private.txt`). Prints only the public key.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/vapid-keys.mjs <directory>");
  process.exit(2);
}
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
writeFileSync(join(dir, "vapid-private.txt"), d, { mode: 0o600 });
writeFileSync(join(dir, "vapid-public.txt"), publicKey);
console.log(publicKey);

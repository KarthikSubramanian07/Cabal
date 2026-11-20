/**
 * The live suite's `test`: each test reaches the server from its own client address.
 *
 * The server limits creating tables and guest accounts to ten a minute per client address
 * (apps/server/wrangler.jsonc). Run whole, both projects make far more than ten tables a minute
 * from one machine, so with one shared address the later tests were turned away with 429 and
 * failed for reasons that had nothing to do with them. `wrangler dev` takes the address from
 * `cf-connecting-ip` as sent, so every test sends its own (in production Cloudflare sets that
 * header itself and a client cannot choose it). The limits stay on, and a test that makes more
 * than ten tables a minute still meets them.
 *
 * Against a deployment (LIVE_ORIGIN) no address is sent: Cloudflare refuses any request that
 * carries `cf-connecting-ip` with 403, and the deployment sees the machine's real address anyway.
 */
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

/** True when the suite runs against a deployment, where a client cannot choose its address. */
export const deployed = Boolean(process.env.LIVE_ORIGIN);

/** A private address for `key`, the same every time for the same key. */
export function addressFor(key: string): string {
  // FNV-1a: small, stable and spread well enough over a few hundred tests.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `10.${(hash >>> 16) & 0xff}.${(hash >>> 8) & 0xff}.${hash & 0xff}`;
}

/** The headers that put a request on the running test's own address. A retry gets a fresh one. */
export function clientHeaders(): Record<string, string> {
  if (deployed) return {};
  const info = base.info();
  return { "cf-connecting-ip": addressFor(`${info.project.name}|${info.testId}|${info.retry}`) };
}

/** `page`, `context` and `request` all carry the test's address; so do the helpers' extra devices. */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => use({ ...extraHTTPHeaders, ...clientHeaders() }),
});

import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("responds on /health through the Durable Object", async () => {
  const res = await SELF.fetch("http://cabal/health");
  expect(await res.text()).toBe("ok");
});

/**
 * Tests run the same on every machine: a developer's `.dev.vars` (VAPID keys, an Anthropic key, a
 * build id kept there for `wrangler dev`) never reaches them. Push is off and every AI seat is the
 * bot unless a suite turns something on itself.
 */
import { describe, expect, it } from "vitest";
import { pushEnabled } from "../src/notify.js";
import { buildId } from "../src/index.js";
import { serverEnv } from "./helpers.js";

describe("the test environment", () => {
  it("holds no secret from local env files", () => {
    const env = serverEnv as unknown as Record<string, unknown>;
    expect(env.VAPID_PRIVATE_KEY || null).toBeNull();
    expect(env.ANTHROPIC_API_KEY || null).toBeNull();
    expect(env.BUILD_ID || null).toBeNull();
    expect(env.ADMIN_TOKEN).toBe("test-admin-token");
  });

  it("keeps push off and the build named by the runtime alone", () => {
    expect(pushEnabled(serverEnv)).toBe(false);
    expect(buildId(serverEnv)).toBe(serverEnv.CF_VERSION_METADATA?.id || "dev");
  });

  it("keeps the plain settings wrangler.jsonc gives", () => {
    const env = serverEnv as unknown as Record<string, unknown>;
    expect(env.PUSH_REMINDER_MINUTES).toBe("60");
    expect(env.VAPID_SUBJECT).toBe("https://playcabal.pages.dev");
    expect(typeof env.VAPID_PUBLIC_KEY).toBe("string");
  });
});

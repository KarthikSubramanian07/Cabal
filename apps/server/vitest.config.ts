import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The Registry is one object shared by every test in a run, so the deployment-wide Claude
      // budget is set wide open here; budget.test.ts narrows it to test the limits themselves.
      miniflare: { bindings: { CLAUDE_USD_PER_DAY: "1000000", CLAUDE_ACTIVE_GAMES: "1000000" } },
    }),
  ],
  // Tests drive real sockets, alarms and a queue inside workerd; leave room for a busy CI runner.
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});

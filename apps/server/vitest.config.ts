import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // The Registry is one object shared by every test in a run, so the deployment-wide Claude
          // budget is set wide open here; budget.test.ts narrows it to test the limits themselves.
          CLAUDE_USD_PER_DAY: "1000000",
          CLAUDE_ACTIVE_GAMES: "1000000",
          // The real migration files, applied to the local D1 database before any test runs
          // (test/setup.ts), so tests and production share one schema.
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  // Tests drive real sockets, alarms and a queue inside workerd; leave room for a busy CI runner.
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});

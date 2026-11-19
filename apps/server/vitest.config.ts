import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  // Tests drive real sockets, alarms and a queue inside workerd; leave room for a busy CI runner.
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});

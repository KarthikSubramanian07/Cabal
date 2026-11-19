import { defineConfig, devices } from "@playwright/test";

/**
 * The lobby against the real game server: `wrangler dev` runs cabal-server (Durable Objects,
 * index and all) on a local port, and `vite preview` serves the built app in front of it with
 * `/api` and the game sockets proxied through, exactly as the Pages worker does in production.
 *
 *   pnpm --filter @cabal/web test:e2e:live
 *
 * Needs the engine built (`pnpm engine:build`) so the server has its WebAssembly. Ports can be
 * moved with LIVE_SERVER_PORT and E2E_LIVE_PORT when another checkout holds the defaults.
 */
const serverPort = Number(process.env.LIVE_SERVER_PORT ?? 8799);
const port = Number(process.env.E2E_LIVE_PORT ?? 4184);
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e-live",
  // Tables are shared state on one server; each test makes its own, so they can still overlap.
  fullyParallel: true,
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "playwright-report-live" }]] : "list",
  use: { baseURL: origin, trace: "retain-on-failure", serviceWorkers: "block" },
  webServer: [
    {
      command: `node ../server/scripts/sync-wasm.mjs && pnpm --dir ../server exec wrangler dev --port ${serverPort} --persist-to .wrangler/e2e-live --show-interactive-dev-session=false`,
      url: `http://localhost:${serverPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { WRANGLER_SEND_METRICS: "false" },
    },
    {
      command: `pnpm build && pnpm exec vite preview --port ${port} --strictPort`,
      url: origin,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: { CABAL_SERVER: `http://localhost:${serverPort}` },
    },
  ],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["iPhone 15"], browserName: "chromium" } },
  ],
});

import { defineConfig, devices } from "@playwright/test";

/** Override when another checkout already holds the default preview port. */
const port = Number(process.env.E2E_PORT ?? 4173);
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Whole games are played through on an emulated phone at three times pixel density.
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: origin, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm build && pnpm exec vite preview --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["iPhone 15"], browserName: "chromium" } },
  ],
});

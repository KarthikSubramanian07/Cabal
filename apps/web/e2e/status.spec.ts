/** /status reads the server's own health check, live, and says plainly when something is wrong. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { fakeServer } from "./api.js";

const healthy = { ok: true, protocol: 2, engine: "0.1.0", build: "8a7f7e3c0ffee", registry: { reachable: true, schema: 5 }, index: { backend: "d1", reachable: true, schema: 13 }, time: Date.UTC(2026, 10, 19) };
const OUT = process.env.STATUS_SHOTS;

test.describe("the status page", () => {
  test("names the build, the engine and the index when the server is well", async ({ page }, info) => {
    const server = await fakeServer(page);
    server.on("GET", /^\/api\/health$/, () => ({ body: healthy }));
    await page.goto("/status");
    await expect(page).toHaveTitle("Status — Cabal");
    await expect(page.getByRole("heading", { level: 1, name: "Cabal is running." })).toBeVisible();
    const facts = page.locator(".status-facts");
    await expect(facts).toContainText("8a7f7e3c0ffee");
    await expect(facts).toContainText("Answering, schema 13 (D1)");
    await expect(facts).toContainText("Version 2, the same as this page");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    if (OUT) await page.screenshot({ path: `${OUT}/${info.project.name}-status-ok.png`, fullPage: true });
    // The footer leads here from every page.
    await page.goto("/ledger");
    await page.getByRole("contentinfo").getByRole("link", { name: "Status" }).click();
    await expect(page).toHaveURL(/\/status$/);
  });

  test("says when the index lags the build, and when nothing answers, then recovers on request", async ({ page }, info) => {
    const server = await fakeServer(page);
    let answer: "behind" | "down" | "well" = "behind";
    server.on("GET", /^\/api\/health$/, () =>
      answer === "behind" ? { status: 503, body: { ...healthy, ok: false, index: { backend: "d1", reachable: true, schema: 12 } } } : answer === "down" ? { status: 502, body: { error: "bad gateway" } } : { body: healthy },
    );
    await page.goto("/status");
    await expect(page.getByRole("heading", { level: 1, name: "The server answers, but not well." })).toBeVisible();
    await expect(page.locator(".status-facts")).toContainText("schema 12");
    answer = "down";
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "The server is not answering." })).toBeVisible();
    if (OUT) await page.screenshot({ path: `${OUT}/${info.project.name}-status-down.png`, fullPage: true });
    answer = "well";
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Cabal is running." })).toBeVisible();
  });
});

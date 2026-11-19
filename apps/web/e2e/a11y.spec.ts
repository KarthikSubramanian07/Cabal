import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { closeSheet, openHelp, openSheet, primary, ready, resolveAndContinue, tap } from "./helpers.js";

/** WCAG 2.2 AA, as the accessibility statement promises. Serious and critical findings fail the build. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${state}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(blocking).toEqual([]);
}

test.describe("accessibility scan", () => {
  test("the board through a whole year of play", async ({ page }) => {
    await ready(page);
    await scan(page, "opening position");

    await tap(page, "VEN");
    await scan(page, "unit selected");
    await tap(page, "TYR");
    await tap(page, "ROM");
    await tap(page, "VEN");
    await openSheet(page);
    await scan(page, "orders written, sidebar open");
    await primary(page).click();
    await scan(page, "results");
    await closeSheet(page);
    await primary(page).click();

    await tap(page, "VEN");
    await tap(page, "TRI");
    await tap(page, "TYR");
    await page.locator(".toolbar").getByRole("button", { name: "Support" }).click();
    await tap(page, "VEN");
    await tap(page, "TRI");
    await resolveAndContinue(page);
    await scan(page, "retreat phase");
    await tap(page, "TRI");
    await scan(page, "dislodged unit selected");
    await tap(page, "ALB");
    await resolveAndContinue(page);
    await scan(page, "winter adjustments");
    await tap(page, "ROM");
    await expect(page.getByRole("menu")).toBeVisible();
    await scan(page, "build menu open");
  });

  test("the coast menu", async ({ page }) => {
    await ready(page);
    await tap(page, "BRE");
    await tap(page, "MAO");
    await resolveAndContinue(page);
    await tap(page, "MAO");
    await tap(page, "SPA");
    await expect(page.getByRole("menu")).toBeVisible();
    await scan(page, "coast menu open");
  });

  test("the dialogs and notices", async ({ page }) => {
    await ready(page);
    await openHelp(page);
    await expect(page.getByRole("dialog", { name: "How to play" })).toBeVisible();
    await scan(page, "how to play");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

    await tap(page, "PAR");
    await tap(page, "BUR");
    await openSheet(page);
    await page.getByRole("button", { name: "New game" }).click();
    await expect(page.getByRole("dialog", { name: "Start a new game?" })).toBeVisible();
    await scan(page, "new game dialog");
    await page.getByRole("button", { name: "Keep playing" }).click();

    await page.locator('input[type="file"]').setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from("nope") });
    await expect(page.locator(".import-error")).toBeVisible();
    await scan(page, "import error");

    await page.reload();
    await expect(page.locator(".resume")).toBeVisible({ timeout: 20_000 });
    await scan(page, "saved game restored");
  });

  for (const path of ["/games", "/g/K7Q2", "/about", "/contact", "/privacy"]) {
    test(`${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await scan(page, path);
    });
  }

  test("the board that failed to load", async ({ page }) => {
    await page.route("**/*.wasm", (route) => route.abort());
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "The board did not load." })).toBeVisible({ timeout: 20_000 });
    await scan(page, "load failure");
  });
});

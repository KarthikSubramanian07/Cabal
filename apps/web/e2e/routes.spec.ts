import { expect, test } from "@playwright/test";

test.describe("routes", () => {
  test("serves the sandbox at / and at /sandbox", async ({ page }) => {
    for (const path of ["/", "/sandbox"]) {
      await page.goto(path);
      await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".phase-title")).toContainText("Spring 1901");
    }
  });

  const reserved: [string, string][] = [
    ["/games", "The games room is not open yet."],
    ["/ledger", "The Ledger is not open yet."],
    ["/g/K7Q2", "This table is not set yet."],
    ["/u/ada", "No file on this player yet."],
    ["/replay/K7Q2", "This replay is not ready yet."],
  ];

  for (const [path, title] of reserved) {
    test(`${path} is reserved with a not-yet page`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByRole("banner").getByRole("img", { name: "Cabal" })).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
      await page.getByRole("link", { name: "Open the sandbox" }).click();
      await expect(page).toHaveURL(/\/sandbox$/);
      await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
      // The browser's back button returns without a reload.
      await page.goBack();
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    });
  }

  test("an unknown in-app path says so", async ({ page }) => {
    await page.goto("/g/not/a/route");
    await expect(page.getByRole("heading", { level: 1, name: "That province is not on the map." })).toBeVisible();
  });
});

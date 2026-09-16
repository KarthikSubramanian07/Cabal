import { expect, test } from "@playwright/test";

test.describe("sandbox", () => {
  test("loads the engine and shows the opening board", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Diplomacy with receipts.").first()).toBeVisible();
    await expect(page.locator(".phase-chip")).toHaveText("S1901M", { timeout: 15_000 });
    // 22 starting units on the map
    await expect(page.locator("svg .unit")).toHaveCount(22);
    // seven power chips with three centres each (Russia four)
    const chips = page.locator(".power-chip");
    await expect(chips).toHaveCount(7);
    await expect(chips.filter({ hasText: "Russia" }).locator(".n")).toHaveText("4");
  });

  test("composes an order by tapping and resolves a phase with receipts", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".phase-chip")).toHaveText("S1901M", { timeout: 15_000 });
    // France is selected by default: tap Paris, then Burgundy
    await page.locator(".province", { has: page.locator("title", { hasText: "Paris" }) }).click();
    await expect(page.getByText("A PAR selected")).toBeVisible();
    await page.locator(".province", { has: page.locator("title", { hasText: "Burgundy" }) }).click();
    await expect(page.locator(".ledger .row.pending")).toHaveText(/A PAR - BUR/);
    await page.getByRole("button", { name: /Resolve S1901M/ }).click();
    await expect(page.locator(".phase-chip")).toHaveText("F1901M");
    const receipts = page.locator('[aria-label="adjudication results"] .row');
    await expect(receipts.first()).toContainText("A PAR - BUR");
    await expect(receipts.first()).toContainText("moves");
  });

  test("looks right on a phone", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone project only");
    await page.goto("/");
    await expect(page.locator(".phase-chip")).toHaveText("S1901M", { timeout: 15_000 });
    await expect(page.locator(".dossier")).toBeVisible();
  });
});

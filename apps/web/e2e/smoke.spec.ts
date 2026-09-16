import { expect, test } from "@playwright/test";

test("renders the shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
});

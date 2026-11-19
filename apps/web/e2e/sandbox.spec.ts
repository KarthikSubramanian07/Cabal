import { expect, test } from "@playwright/test";
import { closeSheet, isPhone, openHelp, openSheet, primary, ready, resolveAndContinue, selectPower, tap } from "./helpers.js";

test.describe("classic board", () => {
  test("draws the opening position of 1901", async ({ page }) => {
    await ready(page);
    await expect(page.getByRole("banner").getByRole("img", { name: "Cabal" })).toBeVisible();
    await expect(page.locator("svg.board-live g.unit")).toHaveCount(22);
    await expect(page.locator("svg.board g.sc")).toHaveCount(34);
    await expect(page.locator("svg.board [data-province]")).toHaveCount(76);
    await openSheet(page);
    await expect(page.locator(".phase-title")).toContainText("Spring 1901");
    const russia = page.locator("table.powers tbody tr", { hasText: "Russia" });
    await expect(russia.locator("td").first()).toHaveText("4");
  });

  test("orders by clicking, supports, and shows receipts in plain words", async ({ page }, info) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await tap(page, "MUN");
    await tap(page, "BUR");
    await tap(page, "MAR");
    // The S key on a keyboard, the Support button under a thumb.
    if (isPhone(info)) await page.getByRole("button", { name: "Support" }).click();
    else await page.keyboard.press("s");
    await tap(page, "PAR");
    await tap(page, "BUR");
    await tap(page, "BRE");
    await tap(page, "BRE");

    await selectPower(page, "France");
    await openSheet(page);
    const france = page.getByLabel("France orders");
    await expect(france).toContainText("A PAR - BUR");
    await expect(france).toContainText("A MAR S A PAR - BUR");
    await expect(france).toContainText("F BRE H");
    await closeSheet(page);

    await expect(primary(page)).toHaveText("Adjudicate Spring 1901");
    await primary(page).click();
    await openSheet(page);
    const results = page.getByLabel("Adjudication results");
    await expect(results).toContainText("A PAR - BUR");
    // Paris went in with Marseilles behind it; the receipt says why Munich lost, not just that it did.
    await expect(results).toContainText("Bounced by the unit from Paris, which had more support.");
    await expect(results).not.toContainText("illegal");
    await expect(page.locator(".tag")).toHaveText("Results");
    await closeSheet(page);

    await expect(primary(page)).toHaveText("Continue to Fall 1901");
    await primary(page).click();
    await openSheet(page);
    await expect(page.locator(".phase-title")).toContainText("Fall 1901");
    await expect(page.locator("table.powers tbody tr", { hasText: "France" }).locator("td").nth(1)).toHaveText("3");
  });

  test("asks which coast when a fleet can reach two", async ({ page }) => {
    await ready(page);
    await tap(page, "BRE");
    await tap(page, "MAO");
    await resolveAndContinue(page);
    await tap(page, "MAO");
    await tap(page, "SPA");
    const picker = page.getByRole("menu");
    await expect(picker).toContainText("F MAO - SPA/NC");
    await expect(page.locator(".toolbar .hint")).toContainText("choose from the menu");
    await picker.getByRole("menuitem", { name: "F MAO - SPA/SC" }).click();
    await openSheet(page);
    await expect(page.getByLabel("France orders")).toContainText("F MAO - SPA/SC");
  });

  test("plays through to builds, then undoes a phase", async ({ page }) => {
    await ready(page);
    await tap(page, "MAR");
    await tap(page, "SPA");
    await resolveAndContinue(page);
    await tap(page, "SPA");
    await tap(page, "POR");
    await expect(primary(page)).toHaveText("Adjudicate Fall 1901");
    await primary(page).click();
    await expect(primary(page)).toHaveText("Continue to Winter 1901 builds");
    await primary(page).click();
    await openSheet(page);
    await expect(page.locator(".phase-meta")).toContainText("Adjustments");

    await selectPower(page, "France");
    await openSheet(page);
    await expect(page.getByLabel("France orders")).toContainText("may build 1 unit");
    await closeSheet(page);
    await tap(page, "MAR");
    await page.getByRole("menuitem", { name: "A MAR B" }).click();
    await openSheet(page);
    await expect(page.getByLabel("France orders")).toContainText("A MAR B");
    await closeSheet(page);
    await expect(primary(page)).toHaveText("Resolve Winter 1901 builds");
    await primary(page).click();
    await expect(primary(page)).toHaveText("Continue to Spring 1902");
    await primary(page).click();
    await openSheet(page);
    await expect(page.locator("table.powers tbody tr", { hasText: "France" }).locator("td").nth(1)).toHaveText("4");

    await page.getByRole("button", { name: "Undo last phase" }).click();
    await expect(page.locator(".phase-title")).toContainText("Winter 1901");
    await expect(page.getByLabel("France orders")).toContainText("A MAR B");
  });

  test("explains how to play", async ({ page }) => {
    await ready(page);
    await openHelp(page);
    const dialog = page.getByRole("dialog", { name: "How to play" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Click a unit, then the province it should move to.");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
  });
});

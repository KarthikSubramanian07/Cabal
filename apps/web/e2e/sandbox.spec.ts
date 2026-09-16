import { type Page, expect, test } from "@playwright/test";

/** Click a province on the board by its label, where a unit or province is easy to hit. */
async function tap(page: Page, code: string) {
  const label = page.locator("svg.board text.label", { hasText: new RegExp(`^${code}$`) }).first();
  const box = await label.boundingBox();
  if (!box) throw new Error(`no label for ${code}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
}

test.describe("classic board", () => {
  test("draws the opening position of 1901", async ({ page }) => {
    await ready(page);
    await expect(page.getByRole("img", { name: "Cabal" }).first()).toBeVisible();
    await expect(page.locator(".phase-title")).toContainText("Spring 1901");
    await expect(page.locator("svg.board g.unit")).toHaveCount(22);
    await expect(page.locator("svg.board g.sc")).toHaveCount(34);
    await expect(page.locator("svg.board [data-province]")).toHaveCount(76);
    const russia = page.locator("table.powers tbody tr", { hasText: "Russia" });
    await expect(russia.locator("td").first()).toHaveText("4");
  });

  test("orders by clicking, supports from the keyboard, and shows receipts", async ({ page }, info) => {
    test.skip(info.project.name === "phone", "keyboard flow is desktop only");
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await tap(page, "MUN");
    await tap(page, "BUR");
    await tap(page, "MAR");
    await page.keyboard.press("s");
    await tap(page, "PAR");
    await tap(page, "BUR");
    await tap(page, "BRE");
    await tap(page, "BRE");

    await page.getByRole("button", { name: /^France/ }).click();
    const france = page.getByLabel("France orders");
    await expect(france).toContainText("A PAR - BUR");
    await expect(france).toContainText("A MAR S A PAR - BUR");
    await expect(france).toContainText("F BRE H");

    await page.getByRole("button", { name: "Adjudicate Spring 1901" }).click();
    const results = page.getByLabel("Adjudication results");
    await expect(results).toContainText("A PAR - BUR");
    await expect(results).toContainText("bounced with PAR");
    await expect(page.locator(".tag")).toHaveText("Results");

    await page.getByRole("button", { name: "Continue to Fall 1901" }).click();
    await expect(page.locator(".phase-title")).toContainText("Fall 1901");
    await expect(page.locator("table.powers tbody tr", { hasText: "France" }).locator("td").nth(1)).toHaveText("3");
  });

  test("asks which coast when a fleet can reach two", async ({ page }, info) => {
    test.skip(info.project.name === "phone", "desktop flow");
    await ready(page);
    await tap(page, "BRE");
    await tap(page, "MAO");
    await page.getByRole("button", { name: "Adjudicate Spring 1901" }).click();
    await page.getByRole("button", { name: "Continue to Fall 1901" }).click();
    await tap(page, "MAO");
    await tap(page, "SPA");
    const picker = page.getByRole("menu");
    await expect(picker).toContainText("F MAO - SPA/NC");
    await picker.getByRole("menuitem", { name: "F MAO - SPA/SC" }).click();
    await expect(page.getByLabel("France orders")).toContainText("F MAO - SPA/SC");
  });

  test("plays through to builds, then undoes a phase", async ({ page }, info) => {
    test.skip(info.project.name === "phone", "desktop flow");
    await ready(page);
    await tap(page, "MAR");
    await tap(page, "SPA");
    await page.getByRole("button", { name: "Adjudicate Spring 1901" }).click();
    await page.getByRole("button", { name: "Continue to Fall 1901" }).click();
    await tap(page, "SPA");
    await tap(page, "POR");
    await page.getByRole("button", { name: "Adjudicate Fall 1901" }).click();
    await page.getByRole("button", { name: "Continue to Winter 1901" }).click();
    await expect(page.locator(".phase-meta")).toContainText("Adjustments");

    await page.getByRole("button", { name: /^France/ }).click();
    await expect(page.getByLabel("France orders")).toContainText("may build 1 unit");
    await tap(page, "MAR");
    await page.getByRole("menuitem", { name: "A MAR B" }).click();
    await expect(page.getByLabel("France orders")).toContainText("A MAR B");
    await page.getByRole("button", { name: "Adjudicate Winter 1901" }).click();
    await page.getByRole("button", { name: "Continue to Spring 1902" }).click();
    await expect(page.locator("table.powers tbody tr", { hasText: "France" }).locator("td").nth(1)).toHaveText("4");

    await page.getByRole("button", { name: "Undo last phase" }).click();
    await expect(page.locator(".phase-title")).toContainText("Winter 1901");
    await expect(page.getByLabel("France orders")).toContainText("A MAR B");
  });

  test("explains how to play", async ({ page }) => {
    await ready(page);
    await page.getByRole("button", { name: "How to play" }).click();
    const dialog = page.getByRole("dialog", { name: "How to play" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Click a unit, then the province it should move to.");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
  });

  test("fits a phone", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "phone only");
    await ready(page);
    const frame = await page.locator(".board-frame").boundingBox();
    const viewport = page.viewportSize()!;
    expect(frame!.width).toBeLessThanOrEqual(viewport.width);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(page.getByRole("button", { name: "Show the whole board" })).toBeEnabled();
  });
});

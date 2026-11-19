/**
 * Readying is a decision in every kind of phase, against the real server: a winter readied with
 * the builds left open waives them, and the player's record counts it as ordered on time, not
 * missed. And a keyboard player arriving by Play now starts on the table, not on the page body.
 */
import { expect, test } from "@playwright/test";
import { chooseHandle, closeSheet, primary, tab, uniqueHandle } from "./room.js";

/** Openings that win most powers a centre in 1901 against the bot. */
const OPEN: Record<string, { S: string[]; F: string[] }> = {
  AUSTRIA: { S: ["A VIE - GAL", "A BUD - SER", "F TRI - ALB"], F: ["A SER H", "F ALB - GRE"] },
  ENGLAND: { S: ["F LON - NTH", "F EDI - NWG", "A LVP - YOR"], F: ["F NWG - NWY", "F NTH H", "A YOR H"] },
  FRANCE: { S: ["A PAR - BUR", "A MAR - SPA", "F BRE - MAO"], F: ["F MAO - POR", "A SPA H", "A BUR H"] },
  GERMANY: { S: ["A BER - KIE", "F KIE - DEN", "A MUN - RUH"], F: ["F DEN H", "A RUH - HOL", "A KIE H"] },
  ITALY: { S: ["A VEN H", "A ROM - APU", "F NAP - ION"], F: ["F ION - TUN", "A APU H", "A VEN H"] },
  RUSSIA: { S: ["F SEV - BLA", "A MOS - UKR", "A WAR - GAL", "F STP/SC - BOT"], F: ["F BOT - SWE", "A UKR - RUM", "F BLA H"] },
  TURKEY: { S: ["F ANK - BLA", "A CON - BUL", "A SMY - ARM"], F: ["A BUL H", "F BLA H", "A ARM H"] },
};

async function readyAndContinue(page: import("@playwright/test").Page) {
  await closeSheet(page);
  await primary(page).click();
  await expect(primary(page)).toHaveText(/^Continue to/, { timeout: 30_000 });
  await primary(page).click();
}

test.describe("readying, live", () => {
  test("a winter readied with the builds left open waives them, and is not a missed turn", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "one whole year is enough on one screen");
    test.slow();
    const handle = uniqueHandle("wint");
    await page.goto("/");
    await page.getByRole("button", { name: /Play now/ }).click();
    await chooseHandle(page, handle);
    await expect(page.locator("svg.board text.label").first()).toBeVisible({ timeout: 30_000 });
    const power = (await page.locator(".you-as").innerText()).trim().toUpperCase();
    for (const season of ["S", "F"] as const) {
      await tab(page, "Orders");
      const box = page.getByRole("combobox", { name: "Write an order" });
      await box.fill(OPEN[power]![season].join("; "));
      await box.press("Enter");
      await readyAndContinue(page);
    }
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).not.toContainText("Fall 1901", { timeout: 20_000 });
    // A power with nothing to build or disband rests, and the winter passes at once.
    if ((await heading.innerText()).includes("Winter 1901")) {
      await tab(page, "Orders");
      // The desk says what readying now means, never "your units hold" in a winter.
      await expect(page.locator(".sync-line")).toHaveText(/^No (builds|disbands) chosen/);
      await readyAndContinue(page);
    }

    // Reliability is written when the game ends: end it.
    await tab(page, "Table");
    await page.getByRole("button", { name: "Vote for a draw" }).click();
    await expect(primary(page)).toHaveText(/final/i, { timeout: 20_000 });
    await expect
      .poll(async () => (await (await page.request.get(`/api/players/${handle}`)).json()).reliability, { timeout: 15_000 })
      .toMatchObject({ missed: 0 });
  });

  test("Play now by keyboard starts the player on the table, not on the page body", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a keyboard walk");
    await page.goto("/");
    await page.getByRole("button", { name: /Play now/ }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Choose your handle" }).getByLabel("Handle").fill(uniqueHandle("keys"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/g\//, { timeout: 20_000 });
    await expect(page.locator("svg.board text.label").first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  });
});

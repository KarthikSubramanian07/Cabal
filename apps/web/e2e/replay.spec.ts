import { type Page, expect, test } from "@playwright/test";
import { openSheet, primary, ready, resolveAndContinue, tap } from "./helpers.js";

const jump = (page: Page) => page.getByRole("combobox", { name: "Jump to phase" });
const scrubber = (page: Page) => page.getByRole("slider", { name: "Scrub through the game" });

/** Three resolved phases: Spring 1901, Fall 1901 and Spring 1902, with Paris marching each spring. */
async function threePhases(page: Page) {
  await tap(page, "PAR");
  await tap(page, "BUR");
  await resolveAndContinue(page);
  await resolveAndContinue(page);
  await expect(primary(page)).toHaveText("Adjudicate Spring 1902");
  await tap(page, "BUR");
  await tap(page, "MUN");
  await resolveAndContinue(page);
  await expect(primary(page)).toHaveText("Adjudicate Fall 1902");
}

test.describe("replay", () => {
  // Reduced motion and double speed keep each phase on screen for under a second.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("plays the whole game from the first phase and stops at the live one", async ({ page }) => {
    await ready(page);
    await threePhases(page);
    await openSheet(page);
    await page.getByRole("button", { name: "Double speed" }).click();
    await expect(page.getByRole("button", { name: "Double speed" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Play the game from the start" }).click();
    await expect(page.getByRole("button", { name: "Pause the replay" })).toBeVisible();
    await expect(jump(page)).toHaveValue("0");
    await expect(scrubber(page)).toHaveAttribute("aria-valuetext", "Spring 1901 movement results");
    await expect(jump(page)).toHaveValue("1");
    await expect(jump(page)).toHaveValue("2");
    await expect(page.getByLabel("Adjudication results")).toContainText("A BUR - MUN");
    await expect(jump(page)).toHaveValue("3");
    await expect(scrubber(page)).toHaveAttribute("aria-valuetext", "Fall 1902 movement, now");
    await expect(page.getByRole("button", { name: "Play the game from the start" })).toBeVisible();
    await expect(primary(page)).toHaveText("Adjudicate Fall 1902");
  });

  test("pausing, stepping or scrubbing keeps the board where the player put it", async ({ page }) => {
    await ready(page);
    await threePhases(page);
    await openSheet(page);
    await page.getByRole("button", { name: "Play the game from the start" }).click();
    await page.getByRole("button", { name: "Pause the replay" }).click();
    await expect(jump(page)).toHaveValue("0");
    await page.waitForTimeout(2000);
    await expect(jump(page)).toHaveValue("0");

    // Play from here, then a step by hand stops the film.
    await page.getByRole("button", { name: "Play from here" }).click();
    await page.locator(".stepper").getByRole("button", { name: "Next phase" }).click();
    await expect(page.getByRole("button", { name: "Play from here" })).toBeVisible();
    await expect(jump(page)).toHaveValue("1");

    await scrubber(page).fill("2");
    await expect(jump(page)).toHaveValue("2");
    await expect(scrubber(page)).toHaveAttribute("aria-valuetext", "Spring 1902 movement results");
    await page.waitForTimeout(1600);
    await expect(jump(page)).toHaveValue("2");
  });
});

test("space plays and pauses the history from the board", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "A keyboard shortcut.");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  await threePhases(page);
  // Space on a focused button presses the button; on the board it is the replay's.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(" ");
  await expect(page.getByRole("button", { name: "Pause the replay" })).toBeVisible();
  await expect(jump(page)).toHaveValue("0");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(" ");
  await expect(page.getByRole("button", { name: "Play from here" })).toBeVisible();
});

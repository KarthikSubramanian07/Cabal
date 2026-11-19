import { type Page, expect, test } from "@playwright/test";
import { ready, tap } from "./helpers.js";

/** France and Germany both march on Burgundy and bounce; England's fleet moves cleanly. */
async function bounceInBurgundy(page: Page) {
  await tap(page, "PAR");
  await tap(page, "BUR");
  await tap(page, "MUN");
  await tap(page, "BUR");
  await tap(page, "LON");
  await tap(page, "NTH");
}

/** Adjudicate, and name the animations running on the results a moment later (strokes draw fast). */
const adjudicateAndWatch = (page: Page) =>
  page.evaluate(() => {
    document.querySelector<HTMLButtonElement>(".sidebar .actions .btn.primary")!.click();
    return new Promise<string[]>((resolve) =>
      setTimeout(
        () =>
          resolve(
            document
              .getAnimations()
              .filter((a) => {
                const target = (a.effect as KeyframeEffect | null)?.target;
                return target instanceof Element && Boolean(target.closest(".order-marks, .standoff"));
              })
              .map((a) => (a as CSSAnimation).animationName),
          ),
        120,
      ),
    );
  });

/** Animations running on the order marks and standoffs of the board. */
const resultAnimations = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target;
        return target instanceof Element && Boolean(target.closest(".order-marks, .standoff"));
      })
      .map((a) => (a as CSSAnimation).animationName),
  );

test.describe("phase results are inked in", () => {
  test("strokes draw, failures are stamped, the standoff washes in, and all of it settles", async ({ page }) => {
    await ready(page);
    await bounceInBurgundy(page);
    const names = await adjudicateAndWatch(page);
    await expect(page.locator("svg.board .order-marks.results")).toBeVisible();
    expect(names).toContain("ink-draw");
    expect(names).toContain("stamp-thud");
    expect(names).toContain("result-fade");
    // The moves wait for nothing here (no supports), but each one starts a beat after the last.
    const delays = await page
      .locator("svg.board .order-marks.results g.order.move")
      .evaluateAll((els) => els.map((el) => (el as SVGElement).style.getPropertyValue("--delay")));
    expect(new Set(delays).size).toBe(delays.length);

    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    expect(await resultAnimations(page)).toEqual([]);
    const stamps = page.locator("svg.board .fail-mark .stamp");
    await expect(stamps).toHaveCount(2);
    for (const opacity of await stamps.evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity))) {
      expect(opacity).toBe("1");
    }
  });

  test("under reduced motion every mark is simply there", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await ready(page);
    await bounceInBurgundy(page);
    expect(await adjudicateAndWatch(page)).toEqual([]);
    await expect(page.locator("svg.board .order-marks.results")).toBeVisible();
    await expect(page.locator("svg.board .fail-mark .stamp")).toHaveCount(2);
    await expect(page.locator("svg.board path.standoff")).toHaveCount(1);
  });

  test("orders being written are not animated", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await expect(page.locator("svg.board .order-marks g.order")).toHaveCount(1);
    expect(await resultAnimations(page)).toEqual([]);
  });
});

import { type Page, expect, test } from "@playwright/test";
import { isPhone, openSheet, primary, ready, tap } from "./helpers.js";

/** Font size of province codes and width of a piece, in CSS pixels, as drawn right now. */
async function mapSizes(page: Page) {
  return page.evaluate(() => {
    const label = document.querySelector("svg.board text.label.land")!;
    const piece = document.querySelector("svg.board g.unit .body")!;
    const svg = document.querySelector<SVGSVGElement>("svg.board")!;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    return {
      label: Number.parseFloat(getComputedStyle(label).fontSize) * scale,
      piece: piece.getBoundingClientRect().width,
    };
  });
}

/** Every visible control smaller than `min` in either direction. */
async function smallTargets(page: Page, min = 44) {
  return page.evaluate((min) => {
    const out: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>("button, a[href], select, summary, input:not([type='hidden']):not([hidden])");
    for (const el of controls) {
      if (el.closest("[hidden], .sr-only") || el.classList.contains("skip-link")) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // A checkbox is hit through its label, which is the full row.
      const hit = el instanceof HTMLInputElement && el.closest("label") ? el.closest("label")!.getBoundingClientRect() : r;
      if (hit.width < min - 0.5 || hit.height < min - 0.5) {
        out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(hit.width)}x${Math.round(hit.height)}`);
      }
    }
    return out;
  }, min);
}

test.describe("map legibility", () => {
  test("province codes and pieces are readable at the default zoom", async ({ page }) => {
    await ready(page);
    const sizes = await mapSizes(page);
    expect(sizes.label).toBeGreaterThanOrEqual(9);
    expect(sizes.piece).toBeGreaterThanOrEqual(15);
  });

  test("they stay readable, and do not balloon, when zoomed in", async ({ page }) => {
    await ready(page);
    const before = await mapSizes(page);
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in" }).click();
    const after = await mapSizes(page);
    expect(after.label).toBeGreaterThan(before.label);
    expect(after.label).toBeLessThan(before.label * 2.2);
    expect(after.piece).toBeGreaterThan(before.piece);
    expect(after.piece).toBeLessThan(before.piece * 2.6);
  });

  test("every code sits inside the province it names", async ({ page }) => {
    await ready(page);
    await page.getByRole("button", { name: "Zoom in" }).click();
    const wrong = await page.evaluate(() => {
      const svg = document.querySelector<SVGSVGElement>("svg.board")!;
      const frame = svg.getBoundingClientRect();
      const out: string[] = [];
      for (const label of svg.querySelectorAll("text.label")) {
        const b = label.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        if (x < frame.left + 2 || x > frame.right - 60 || y < frame.top + 2 || y > Math.min(frame.bottom, innerHeight) - 60) continue;
        const under = document.elementFromPoint(x, y)?.closest("[data-province]")?.getAttribute("data-province");
        if (under !== label.textContent) out.push(`${label.textContent} over ${under}`);
      }
      return out;
    });
    expect(wrong).toEqual([]);
  });
});

test.describe("phone layout", () => {
  test.beforeEach(({}, info) => {
    test.skip(!isPhone(info), "phone only");
  });

  test("the first screen is the board, the order tools and the phase's main action", async ({ page }) => {
    await ready(page);
    const viewport = page.viewportSize()!;
    const frame = (await page.locator(".board-frame").boundingBox())!;
    expect(frame.width).toBeCloseTo(viewport.width, 0);
    // Board first: it starts under the top bar and takes most of the screen.
    expect(frame.y).toBeLessThan(70);
    expect(frame.height).toBeGreaterThan(viewport.height * 0.45);

    for (const locator of [primary(page), page.locator(".toolbar").getByRole("button", { name: "Support" }), page.locator(".sheet-bar")]) {
      await expect(locator).toBeInViewport({ ratio: 1 });
    }
    await expect(primary(page)).toHaveText("Adjudicate Spring 1901");
    // Nothing spills sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  });

  test("opens on the active power's theatre, where a thumb can order without zooming", async ({ page }) => {
    await ready(page);
    await expect(page.getByRole("button", { name: "Show the whole board" })).toBeEnabled();
    // France's units are on screen and big enough to hit.
    const sizes = await mapSizes(page);
    expect(sizes.label).toBeGreaterThanOrEqual(9);
    expect(sizes.piece).toBeGreaterThanOrEqual(15);
    await tap(page, "PAR");
    await tap(page, "BUR");
    // Still on the theatre view: no detour through the whole board was needed.
    await expect(page.getByRole("button", { name: "Show the whole board" })).toBeEnabled();
    await expect(page.locator(".sheet-note")).toHaveText("France: 1 of 3 orders");
  });

  test("a tap that just misses a piece still picks it", async ({ page }) => {
    await ready(page);
    // Land in the sea just off Brest, a few pixels from the fleet.
    const point = await page.evaluate(() => {
      const svg = document.querySelector("svg.board")!;
      const fleet = [...svg.querySelectorAll("g.unit")].find((g) => g.querySelector("title")?.textContent === "France: F BRE")!;
      const b = fleet.getBoundingClientRect();
      for (let dx = -8; dx >= -22; dx -= 2) {
        const x = b.left + dx;
        const y = b.top + b.height / 2;
        const under = document.elementFromPoint(x, y)?.closest("[data-province]")?.getAttribute("data-province");
        if (under && under !== "BRE") return { x, y, under };
      }
      return null;
    });
    expect(point).not.toBeNull();
    await page.touchscreen.tap(point!.x, point!.y);
    await expect(page.locator(".toolbar .hint")).toContainText("F BRE:");
  });

  test("the sheet opens for the table and orders, and picking a power moves the map to it", async ({ page }) => {
    await ready(page);
    const svg = page.locator("svg.board");
    const before = await svg.getAttribute("viewBox");
    await expect(page.locator("table.powers")).toBeHidden();
    await openSheet(page);
    await expect(page.locator("table.powers")).toBeVisible();
    await expect(primary(page)).toBeInViewport({ ratio: 1 });
    await page.locator("table.powers").getByRole("button", { name: "Turkey" }).click();
    await expect.poll(() => svg.getAttribute("viewBox")).not.toBe(before);
    await page.locator(".sheet-bar").click();
    await expect(page.locator(".sheet-note")).toHaveText("Turkey: 0 of 3 orders");
    await tap(page, "CON");
    await expect(page.locator(".toolbar .hint")).toContainText("A CON:");
  });

  test("every control is at least 44px, with the sheet closed and open", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    expect(await smallTargets(page)).toEqual([]);
    await openSheet(page);
    expect(await smallTargets(page)).toEqual([]);
    await primary(page).click();
    expect(await smallTargets(page)).toEqual([]);
  });

  test("the rest of the site is one tap away in the menu", async ({ page }) => {
    await ready(page);
    const nav = page.getByRole("navigation", { name: "Site" });
    await expect(nav).toBeHidden();
    await page.getByRole("button", { name: "Menu" }).click();
    for (const name of ["Sandbox", "About", "Contact", "GitHub"]) await expect(nav.getByRole("link", { name })).toBeVisible();
    await expect(nav.getByRole("button", { name: "How to play" })).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(nav).toBeHidden();
  });

  test("on its side, board and orders sit side by side with the main action in reach", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await ready(page);
    const frame = (await page.locator(".board-frame").boundingBox())!;
    const side = (await page.locator(".sidebar").boundingBox())!;
    expect(frame.x).toBe(0);
    expect(side.x).toBeGreaterThanOrEqual(frame.x + frame.width - 1);
    expect(frame.height).toBeGreaterThan(240);
    await expect(primary(page)).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".toolbar").getByRole("button", { name: "Support" })).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".sheet-bar")).toBeHidden();
    await expect(page.locator("table.powers")).toBeVisible();
    const sizes = await mapSizes(page);
    expect(sizes.label).toBeGreaterThanOrEqual(9);

    await tap(page, "PAR");
    await tap(page, "BUR");
    await expect(page.getByLabel("France orders")).toContainText("A PAR - BUR");
    await primary(page).click();
    await expect(primary(page)).toHaveText("Continue to Fall 1901");
    expect(await smallTargets(page)).toEqual([]);
  });
});

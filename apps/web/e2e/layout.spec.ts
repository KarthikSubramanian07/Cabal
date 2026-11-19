import { type Page, expect, test } from "@playwright/test";
import { isPhone, openHelp, openSheet, primary, ready, tap } from "./helpers.js";

/** Font size of province codes and width of a piece, in CSS pixels, as drawn right now. */
async function mapSizes(page: Page) {
  return page.evaluate(() => {
    const label = document.querySelector("svg.board text.label.land")!;
    const piece = document.querySelector("svg.board-live g.unit .body")!;
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
      // A link in a sentence is sized by its line of text (the inline exception of WCAG 2.5.8).
      if (el instanceof HTMLAnchorElement && style.display === "inline" && el.closest("p, li")) continue;
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
  test("province codes and pieces are readable at the default zoom", async ({ page }, info) => {
    // A phone opens zoomed to this size; a desktop reaches it with the whole board at 1440x900.
    if (!isPhone(info)) await page.setViewportSize({ width: 1440, height: 900 });
    await ready(page);
    const sizes = await mapSizes(page);
    expect(sizes.label).toBeGreaterThanOrEqual(9.9);
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

  test("no province code is written over another, at the default zoom or closer", async ({ page }) => {
    await ready(page);
    // The letters themselves, not the line box round them: a line box is nearly twice as tall
    // as a capital, so two codes on neighbouring lines have boxes that touch though the ink
    // does not (Edinburgh over Liverpool is the tightest pair on the board).
    const collisions = () =>
      page.evaluate(() => {
        const svg = document.querySelector<SVGSVGElement>("svg.board")!;
        const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
        const ink = [...svg.querySelectorAll("text.label")].map((t) => {
          const b = t.getBoundingClientRect();
          const cap = Number.parseFloat(getComputedStyle(t).fontSize) * scale * 0.72;
          const mid = b.top + b.height / 2;
          return { code: t.textContent!, left: b.left, right: b.right, top: mid - cap / 2, bottom: mid + cap / 2 };
        });
        const out: string[] = [];
        for (let i = 0; i < ink.length; i++) {
          for (let j = i + 1; j < ink.length; j++) {
            const a = ink[i]!;
            const b = ink[j]!;
            const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (across > 0.5 && down > 0.5) out.push(`${a.code} over ${b.code}`);
          }
        }
        return out;
      });
    expect(await collisions()).toEqual([]);
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "Zoom in" }).click();
      expect(await collisions(), `zoom step ${i + 1}`).toEqual([]);
    }
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

test.describe("brand", () => {
  test("the chrome is square cornered and the only shadow is the one under the board", async ({ page }) => {
    const audit = () =>
      page.evaluate(() => {
        const rounded: string[] = [];
        const shadowed: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("body *")) {
          if (el.closest("svg")) continue; // pieces and seals are drawn shapes, not chrome
          const style = getComputedStyle(el);
          const name = `${el.tagName.toLowerCase()}.${el.className}`;
          if ([style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].some((r) => r !== "0px")) {
            // A checkbox keeps the shape the platform gives it.
            if (!(el instanceof HTMLInputElement)) rounded.push(name);
          }
          const outer = style.boxShadow.split(/,(?![^(]*\))/).filter((s) => s.trim() !== "none" && !s.includes("inset"));
          if (outer.length && !el.classList.contains("board-frame")) shadowed.push(name);
        }
        return { rounded, shadowed };
      });
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await openSheet(page);
    expect(await audit()).toEqual({ rounded: [], shadowed: [] });
    await page.getByRole("button", { name: "New game" }).click();
    expect(await audit()).toEqual({ rounded: [], shadowed: [] });
    await page.getByRole("button", { name: "Keep playing" }).click();
    // The coast menu floats over the map; it is lifted by a rule, not a shadow.
    await page.goto("/");
    await expect(page.locator("svg.board")).toBeVisible();
    await tap(page, "MAO");
    await tap(page, "SPA");
    const menu = page.getByRole("menu");
    if (await menu.isVisible()) expect(await audit()).toEqual({ rounded: [], shadowed: [] });
    await page.goto("/about");
    expect(await audit()).toEqual({ rounded: [], shadowed: [] });
  });

  test("the phone menu and the dialogs carry no vermilion rule of their own", async ({ page }, info) => {
    await ready(page);
    const vermilion = "rgb(217, 79, 48)";
    if (isPhone(info)) {
      await page.getByRole("button", { name: "Menu" }).click();
      const nav = page.getByRole("navigation", { name: "Site" });
      const borders = await nav.evaluate((el) => [getComputedStyle(el).borderTopColor, getComputedStyle(el).borderBottomColor, getComputedStyle(el).borderTopWidth]);
      expect(borders[1]).not.toBe(vermilion);
      expect(borders[0] === vermilion && borders[2] !== "0px").toBe(false);
      await page.getByRole("button", { name: "Menu" }).click();
    }
    await openHelp(page);
    const header = page.getByRole("dialog", { name: "How to play" }).locator("header");
    expect(await header.evaluate((el) => `${getComputedStyle(el).borderBottomWidth} ${getComputedStyle(el).borderBottomColor}`)).not.toBe(`3px ${vermilion}`);
  });
});

test.describe("desktop layout", () => {
  test.beforeEach(({}, info) => {
    test.skip(isPhone(info), "desktop only");
  });

  for (const [width, height] of [
    [1280, 720],
    [1366, 768],
    [1440, 900],
  ] as const) {
    test(`a ${width}x${height} laptop opens on the whole board`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await ready(page);
      await expect(page.locator("svg.board")).toHaveAttribute("data-whole", "true");
      // Every power's home is on screen: St Petersburg and Smyrna as much as Paris.
      for (const code of ["STP", "SMY", "EDI", "NAP"]) {
        await expect(page.locator(`svg.board [data-province="${code}"]`)).toBeInViewport();
      }
      // Small on the shortest screens, never illegible; one zoom step makes them 10px and more.
      expect((await mapSizes(page)).label).toBeGreaterThanOrEqual(7.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  test("every control is at least 24px, the WCAG 2.2 minimum for a pointer", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    expect(await smallTargets(page, 24)).toEqual([]);
    await primary(page).click();
    expect(await smallTargets(page, 24)).toEqual([]);
    await page.getByRole("button", { name: "Zoom in" }).click();
    expect(await smallTargets(page, 24)).toEqual([]);
    for (const path of ["/about", "/games"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await smallTargets(page, 24), path).toEqual([]);
    }
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
    expect(sizes.label).toBeGreaterThanOrEqual(9.9);
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
      const svg = document.querySelector(".board-frame")!;
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

  test("ordering on the map does not scroll the board out from under the finger", async ({ page }) => {
    await ready(page);
    for (const code of ["PAR", "BUR", "MAR", "SPA", "BRE"]) {
      await tap(page, code);
      expect(await page.evaluate(() => window.scrollY), code).toBe(0);
    }
    await expect(page.locator(".toolbar .hint")).toContainText("F BRE:");
    await expect(page.getByRole("banner")).toBeInViewport();
  });

  test("the pan arrows wait behind one button, so the map is not buried under controls", async ({ page }) => {
    await ready(page);
    const arrows = page.getByRole("group", { name: "Move the map" });
    const toggle = page.getByRole("button", { name: "Move the map with buttons" });
    await expect(arrows).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Four controls over the map, not seven.
    expect(await page.locator(".board-frame button:visible").count()).toBe(4);

    const view = () => page.locator("svg.board").getAttribute("viewBox");
    const before = await view();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(arrows).toBeVisible();
    await arrows.getByRole("button", { name: "Pan right" }).click();
    expect(await view()).not.toBe(before);
    expect(await smallTargets(page)).toEqual([]);
    await toggle.click();
    await expect(arrows).toBeHidden();
  });

  test("How to play does not tell a phone to press keys", async ({ page }) => {
    await ready(page);
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("button", { name: "How to play" }).click();
    const dialog = page.getByRole("dialog", { name: "How to play" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("table.keys kbd:visible")).toHaveCount(0);
    const text = await dialog.locator("table.keys").innerText();
    expect(text).not.toMatch(/press/i);
    expect(text).toContain("choose Support");
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

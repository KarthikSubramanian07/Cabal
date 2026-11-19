import { type Locator, type Page, type TestInfo, expect } from "@playwright/test";

export const isPhone = (info: TestInfo) => info.project.name === "phone";

/** Open the sandbox on a fresh game. */
export async function ready(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
}

/**
 * Click or tap a province on the board. The point used is the province's code where that is
 * unobstructed, or else the nearest free spot inside the province's own outline. Touch
 * projects tap, so the phone run exercises the same pointer path a finger does. A small
 * board opens on one theatre; if the province is off screen the whole board is shown first,
 * as a player would do.
 */
export async function tap(page: Page, code: string) {
  const find = () =>
    page.evaluate((code) => {
      const svg = document.querySelector("svg.board");
      const path = svg?.querySelector(`[data-province="${code}"]`);
      const label = [...(svg?.querySelectorAll("text.label") ?? [])].find((t) => t.textContent === code);
      if (!svg || !path) return null;
      const frame = svg.getBoundingClientRect();
      const hits = (x: number, y: number) =>
        // inside the map, clear of the zoom and pan buttons laid over it
        x > frame.left + 3 &&
        x < frame.right - 3 &&
        y > frame.top + 3 &&
        y < frame.bottom - 3 &&
        y < window.innerHeight &&
        document.elementFromPoint(x, y)?.closest("[data-province]") === path;
      if (label) {
        const b = label.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        if (hits(x, y)) return { x, y };
      }
      const b = path.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      let best: { x: number; y: number; d: number } | null = null;
      for (let i = 1; i < 24; i++) {
        for (let j = 1; j < 24; j++) {
          const x = b.left + (b.width * i) / 24;
          const y = b.top + (b.height * j) / 24;
          const d = Math.hypot(x - cx, y - cy);
          if ((!best || d < best.d) && hits(x, y)) best = { x, y, d };
        }
      }
      return best ? { x: best.x, y: best.y } : null;
    }, code);
  let at = await find();
  if (!at) {
    await page.getByRole("button", { name: "Show the whole board" }).click();
    at = await find();
  }
  if (!at) throw new Error(`cannot reach ${code} on the board`);
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (touch) await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.click(at.x, at.y);
}

/** The sidebar is a sheet on small screens: open it before reading orders, powers or results. */
export async function openSheet(page: Page) {
  const bar = page.locator(".sheet-bar");
  if ((await bar.isVisible()) && (await bar.getAttribute("aria-expanded")) === "false") await bar.click();
}

export async function closeSheet(page: Page) {
  const bar = page.locator(".sheet-bar");
  if ((await bar.isVisible()) && (await bar.getAttribute("aria-expanded")) === "true") await bar.click();
}

/** Pick a power in the table (opening the sheet for it on a phone, and closing it again). */
export async function selectPower(page: Page, power: string) {
  await openSheet(page);
  await page.locator("table.powers").getByRole("button", { name: power }).click();
  await closeSheet(page);
}

/** The phase's one main button (Adjudicate, Resolve, Continue), reachable without opening anything. */
export function primary(page: Page): Locator {
  return page.locator(".sidebar .actions .btn.primary");
}

/** Resolve the phase on the board and go on to the next one. */
export async function resolveAndContinue(page: Page) {
  await primary(page).click();
  await expect(page.locator(".sidebar .actions .btn.primary")).toHaveText(/^(Continue|See|Next)/);
  await primary(page).click();
}

/** An element of the sidebar, with the sheet opened first where there is one. */
export async function inSheet(page: Page, locator: Locator): Promise<Locator> {
  await openSheet(page);
  return locator;
}

export async function openHelp(page: Page) {
  const menu = page.getByRole("button", { name: "Menu" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "How to play" }).click();
}

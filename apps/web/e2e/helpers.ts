import { type Locator, type Page, type TestInfo, expect } from "@playwright/test";

export const isPhone = (info: TestInfo) => info.project.name === "phone";

/** Open the sandbox on a fresh game. */
export async function ready(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
}

/**
 * Click or tap a province on the board at its label, which is always inside the province.
 * Touch projects tap, so the phone run exercises the same pointer path a finger does. A
 * small board opens on one theatre; if the province is off screen the whole board is shown
 * first, as a player would do.
 */
export async function tap(page: Page, code: string) {
  const svg = page.locator("svg.board");
  const label = svg.locator("text.label", { hasText: new RegExp(`^${code}$`) }).first();
  const inView = async () => {
    const [box, frame] = await Promise.all([label.boundingBox(), svg.boundingBox()]);
    if (!box || !frame) throw new Error(`no label for ${code}`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // Stay clear of the zoom and pan buttons laid over the map's right edge.
    const clear = x > frame.x + 4 && x < frame.x + frame.width - 56 && y > frame.y + 4 && y < frame.y + frame.height - 4;
    return { x, y, clear };
  };
  let at = await inView();
  if (!at.clear) {
    await page.getByRole("button", { name: "Show the whole board" }).click();
    at = await inView();
    if (!at.clear) throw new Error(`${code} is under the map controls`);
  }
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

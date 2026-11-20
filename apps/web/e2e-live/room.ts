/**
 * Helpers for the game room against a real cabal-server: tables made over the API, seats kept the
 * way the app keeps them (localStorage, never a URL), and the sidebar reached on either screen.
 */
import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, type Browser, type Page, type TestInfo, expect } from "@playwright/test";
import { clientHeaders } from "./fixtures.js";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export async function scan(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${state}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(blocking).toEqual([]);
}

export interface Seat {
  gameId: string;
  power: string;
  token: string;
  name: string;
}

/** A live table with two people seated and the five other seats left to the bot, started. */
export async function liveTable(request: APIRequestContext): Promise<{ host: Seat; guest: Seat }> {
  const made = await (await request.post("/api/games", { data: { name: "Ada", settings: { pacing: "live", aiFill: true, visibility: "unlisted" } } })).json();
  const host: Seat = { gameId: made.gameId, power: made.power, token: made.token, name: "Ada" };
  const joined = await (await request.post(`/api/games/${host.gameId}/join`, { data: { name: "Bea" } })).json();
  const guest: Seat = { gameId: joined.gameId, power: joined.power, token: joined.token, name: "Bea" };
  const started = await request.post(`/api/games/${host.gameId}/start`, { headers: { authorization: `Bearer ${host.token}` } });
  expect(started.ok()).toBe(true);
  return { host, guest };
}

/** Handles are unique on the server, which keeps them between runs: each test makes its own. */
export const uniqueHandle = (stem: string) => `${stem}_${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 36).toString(36)}`;

/** The handle dialog that the first sit-down opens: write one in and take it. */
export async function chooseHandle(page: Page, handle: string) {
  const dialog = page.getByRole("dialog", { name: "Choose your handle" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Handle").fill(handle);
  await dialog.getByRole("button", { name: "Take this handle" }).click();
  await expect(dialog).toBeHidden();
}

/** A person on their own device (this project's kind of device), holding `seat` or watching without one. */
export async function sitDown(browser: Browser, info: TestInfo, seat: Seat | null, gameId: string): Promise<Page> {
  const use = info.project.use;
  const context = await browser.newContext({
    ...(use.viewport ? { viewport: use.viewport } : {}),
    ...(use.userAgent ? { userAgent: use.userAgent } : {}),
    ...(use.deviceScaleFactor ? { deviceScaleFactor: use.deviceScaleFactor } : {}),
    isMobile: Boolean(use.isMobile),
    hasTouch: Boolean(use.hasTouch),
    baseURL: use.baseURL ?? `http://localhost:${process.env.E2E_LIVE_PORT ?? 4184}`,
    serviceWorkers: "block",
    extraHTTPHeaders: clientHeaders(),
  });
  if (seat) {
    await context.addInitScript((s) => localStorage.setItem(`cabal.seat.${s.gameId}`, JSON.stringify({ ...s, savedAt: Date.now() })), seat);
  }
  const page = await context.newPage();
  await page.goto(`/g/${gameId}`);
  await expect(page.locator("svg.board text.label").first()).toBeVisible({ timeout: 30_000 });
  return page;
}

/** The sidebar is a sheet on a phone: open it, then pick a tab. */
export async function tab(page: Page, name: "Orders" | "Results" | "Press" | "Table" | "Final" | "Board") {
  const bar = page.locator(".sheet-bar");
  if ((await bar.isVisible()) && (await bar.getAttribute("aria-expanded")) === "false") await bar.click();
  await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
}

export async function closeSheet(page: Page) {
  const bar = page.locator(".sheet-bar");
  if ((await bar.isVisible()) && (await bar.getAttribute("aria-expanded")) === "true") await bar.click();
}

/** The phase's one main button, always in reach. */
export const primary = (page: Page) => page.locator(".live-side .actions .btn.primary");

export const titleCase = (power: string) => power[0] + power.slice(1).toLowerCase();

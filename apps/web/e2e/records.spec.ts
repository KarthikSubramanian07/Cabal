import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { fakeServer, fixture, signedIn } from "./api.js";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${state}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

/** The recorded server: three players after five rated games, and the last of those games. */
async function recorded(page: Page) {
  const server = await fakeServer(page);
  server.on("GET", /^\/api\/players\/kestrel$/i, () => ({ body: fixture("profile-kestrel") }));
  server.on("GET", /^\/api\/ledger$/, () => ({ body: fixture("trust") }));
  server.on("GET", /^\/api\/leaderboard$/, () => ({ body: fixture("leaderboard") }));
  server.on("GET", /^\/api\/games\/Z2BSVX$/, () => ({ body: fixture("summary-Z2BSVX") }));
  server.on("GET", /^\/api\/games\/Z2BSVX\/replay$/, () => ({ body: fixture("replay-Z2BSVX") }));
  server.on("GET", /^\/api\/games\/Z2BSVX\/ledger$/, () => ({ body: fixture("ledger-Z2BSVX") }));
  return server;
}

test.describe("a player's record", () => {
  test("shows the rating and its path, reliability, the Ledger and recent games", async ({ page }) => {
    await recorded(page);
    await page.goto("/u/kestrel");
    await expect(page.getByRole("heading", { level: 1, name: "kestrel" })).toBeVisible();
    await expect(page).toHaveTitle("kestrel — Cabal");
    const rating = page.getByRole("region", { name: "Rating" });
    await expect(rating).toContainText("1515");
    await expect(rating).toContainText("Ranked 1 on the ladder.");
    // One point per rated game plus where the path started, each a stop for the keyboard.
    const points = rating.locator(".rating-point");
    await expect(points).toHaveCount(6);
    await points.last().focus();
    await expect(page.locator(".rating-tip")).toContainText("to 1515");
    await rating.getByText("The figures").click();
    await expect(rating.getByRole("table")).toContainText("Before these games");
    await expect(page.getByRole("region", { name: "Reliability" })).toContainText("Ordered on time in 20 of 21 phases");
    const ledger = page.getByRole("region", { name: "The Ledger" });
    await expect(ledger).toContainText("Kept 10 of 20 promises.");
    await expect(ledger.getByRole("list", { name: "Promises on the record" })).toContainText("10 broken");
    const recent = page.getByRole("region", { name: "Recent games" });
    await expect(recent.getByRole("row")).toHaveCount(6);
    await scan(page, "profile");
    await recent.getByRole("link", { name: "Replay the game Z2BSVX" }).click();
    await expect(page).toHaveURL(/\/replay\/Z2BSVX$/);
  });

  test("an unknown handle says so, and the owner sees their account button", async ({ page }) => {
    const server = await recorded(page);
    server.on("GET", /^\/api\/players\/nobody_here$/, () => ({ status: 404, body: { error: "no such player" } }));
    await page.goto("/u/nobody_here");
    await expect(page.getByRole("heading", { level: 1, name: "Nobody goes by that handle." })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
  });
});

test.describe("the Ledger", () => {
  test("ranks by trust, then by rating, and marks the viewer's own row", async ({ page }) => {
    await recorded(page);
    await page.goto("/ledger");
    await expect(page.getByRole("heading", { level: 1, name: "The Ledger" })).toBeVisible();
    const trust = page.getByRole("tabpanel");
    await expect(trust.getByRole("row")).toHaveCount(4);
    await expect(trust.getByRole("row").nth(1)).toContainText("marlowe");
    await expect(trust.getByRole("row").nth(1)).toContainText("83%");
    await scan(page, "ledger by trust");
    await page.getByRole("tab", { name: "By rating" }).click();
    await expect(page).toHaveURL(/\/ledger\?by=rating$/);
    await expect(page.getByRole("tab", { name: "By rating" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").getByRole("row").nth(1)).toContainText("kestrel");
    await page.getByRole("tabpanel").getByRole("link", { name: "kestrel" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "kestrel" })).toBeVisible();
  });

  test("an empty Ledger says how a promise gets onto it", async ({ page }) => {
    const server = await fakeServer(page);
    server.on("GET", /^\/api\/ledger$/, () => ({ body: { entries: [], offset: 0, limit: 50, next: null } }));
    await page.goto("/ledger");
    await expect(page.getByText("Nobody is on the Ledger yet.")).toBeVisible();
    await scan(page, "empty ledger");
  });

  test("pages through a long Ledger", async ({ page }) => {
    const server = await fakeServer(page);
    const row = (rank: number) => ({ rank, player: { id: `p${rank}`, handle: `player${rank}`, createdAt: 1 }, trust: { score: 0.6, kept: 3, broken: 0, void: 0 }, games: 2 });
    server.on("GET", /^\/api\/ledger$/, (request) => {
      const offset = Number(new URL(request.url()).searchParams.get("offset") ?? 0);
      return { body: { entries: Array.from({ length: offset ? 3 : 50 }, (_, i) => row(offset + i + 1)), offset, limit: 50, next: offset ? null : 50 } };
    });
    await signedIn(page);
    await page.goto("/ledger");
    await expect(page.getByRole("tabpanel").getByRole("row")).toHaveCount(51);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByRole("tabpanel").getByRole("row")).toHaveCount(54);
    await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);
  });
});

test.describe("a finished game's replay", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("plays back phase by phase, pauses, steps, scrubs and ends on the final position", async ({ page }, info) => {
    await recorded(page);
    await page.goto("/replay/Z2BSVX");
    await expect(page.getByRole("heading", { level: 1, name: "Replay of table Z2B SVX" })).toBeAttached({ timeout: 20_000 });
    await expect(page.locator("svg.board")).toBeVisible();
    if (info.project.name === "phone") await page.locator(".sheet-bar").click();
    const jump = page.getByRole("combobox", { name: "Jump to phase" });
    await expect(jump).toHaveValue("0");
    await expect(page.getByRole("group", { name: "Adjudication results" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Replay from here" }).click();
    await expect(jump).toHaveValue("1", { timeout: 10_000 });
    await page.getByRole("button", { name: "Pause the replay" }).click();
    const at = await jump.inputValue();
    await page.getByRole("button", { name: "Next phase" }).click();
    await expect(jump).toHaveValue(String(Number(at) + 1));
    const scrubber = page.getByRole("slider", { name: "Scrub through the game" });
    await scrubber.focus();
    await page.keyboard.press("End");
    await expect(scrubber).toHaveAttribute("aria-valuetext", "Final position");
    await expect(jump.locator("option:checked")).toHaveText("Final position");
    // The end of the game: the result, and the Ledger with each seal opened on this device.
    await expect(page.getByText(/A draw/).first()).toBeVisible();
    await scan(page, "replay at the end");
  });

  test("Space plays and pauses when the page has focus", async ({ page }, info) => {
    await recorded(page);
    await page.goto("/replay/Z2BSVX");
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
    if (info.project.name === "phone") await page.locator(".sheet-bar").click();
    await page.locator("main").focus();
    await page.keyboard.press(" ");
    await expect(page.getByRole("button", { name: "Pause the replay" })).toBeAttached();
    await page.keyboard.press(" ");
    await expect(page.getByRole("button", { name: /^Replay/ })).toBeAttached();
  });

  test("a game still in play points to the live table, and an unknown code says so", async ({ page }) => {
    const server = await fakeServer(page);
    const summary = fixture<Record<string, unknown>>("summary-Z2BSVX");
    server.on("GET", /^\/api\/games\/K7Q2XZ$/, () => ({ body: { ...summary, id: "K7Q2XZ", status: "active", finished: null } }));
    await page.goto("/replay/K7Q2XZ");
    await expect(page.getByRole("heading", { level: 1, name: "This game is still being played." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Watch it live" })).toHaveAttribute("href", "/g/K7Q2XZ");
    await page.goto("/replay/NOPE99");
    await expect(page.getByRole("heading", { level: 1, name: "No game goes by that code." })).toBeVisible();
  });
});

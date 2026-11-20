import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { accountRoutes, fakeServer, fixture, freshProfile, signedIn } from "./api.js";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${state}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

/** The recorded server: three players after five rated games, and the last of those games. */
async function recorded(page: Page) {
  const server = await fakeServer(page);
  server.on("GET", /^\/api\/players\/kestrel$/i, () => ({ body: fixture("profile-kestrel") }));
  server.on("GET", /^\/api\/players\/kestrel\/ratings$/i, () => ({ body: fixture("ratings-kestrel") }));
  server.on("GET", /^\/api\/ledger$/, () => ({ body: fixture("trust") }));
  server.on("GET", /^\/api\/leaderboard$/, () => ({ body: fixture("leaderboard") }));
  server.on("GET", /^\/api\/games\/Z2BSVX$/, () => ({ body: fixture("summary-Z2BSVX") }));
  server.on("GET", /^\/api\/games\/Z2BSVX\/replay$/, () => ({ body: fixture("replay-Z2BSVX") }));
  server.on("GET", /^\/api\/games\/Z2BSVX\/ledger$/, () => ({ body: fixture("ledger-Z2BSVX") }));
  return server;
}

/** ada_l after one Play now game, drawn: a friendly table, so nothing public and no seals counted. */
async function afterAFriendlyGame(page: Page) {
  const server = await fakeServer(page);
  const account = accountRoutes(server);
  const finishedAt = Date.UTC(2026, 10, 18);
  const played = { ...freshProfile(), games: { played: 1, solos: 0, draws: 1 } };
  const game = { gameId: "K7Q2XZ", power: "TURKEY", result: "draw", score: 1 / 7, centers: 3, substitute: false, walkedOut: false, ratingDelta: null, finishedAt };
  server.on("GET", /^\/api\/players\/ada_l$/i, () => ({ body: played }));
  server.on("GET", /^\/api\/me$/, () => ({
    body: { ...played, recent: [game], account: { renameAvailableAt: null, recoveryIssuedAt: account.recoveryIssuedAt, sessions: 1 } },
  }));
  server.on("GET", /^\/api\/me\/games$/, () => ({
    body: {
      games: [
        { gameId: "K7Q2XZ", power: "TURKEY", status: "finished", joinedAt: finishedAt - 600_000, finishedAt, result: "draw", score: 1 / 7, centers: 3, ratingDelta: null },
        // Drawn by vote before the first phase resolved: void, kept as abandoned.
        { gameId: "QQ7R3D", power: "ITALY", status: "abandoned", joinedAt: finishedAt - 60_000, finishedAt: finishedAt - 30_000, result: "draw", score: 0, centers: 3, ratingDelta: null },
      ],
    },
  }));
  return server;
}

test.describe("what the record pages download", () => {
  for (const path of ["/ledger", "/u/kestrel", "/games"]) {
    test(`${path} fetches neither the board nor the engine it never draws`, async ({ page }) => {
      const server = await recorded(page);
      server.on("GET", /^\/api\/games$/, () => ({ body: { games: [], total: 0 } }));
      const heavy: string[] = [];
      page.on("request", (r) => {
        const u = new URL(r.url());
        if (/\.wasm$|\/board-|\/SandboxPage-/.test(u.pathname)) heavy.push(u.pathname);
      });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(heavy).toEqual([]);
    });
  }
});

test.describe("a record after friendly games", () => {
  test("agrees with itself: the game played is listed for its player, and the Ledger says why it is empty", async ({ page }) => {
    await afterAFriendlyGame(page);
    await signedIn(page);
    await page.goto("/u/ada_l");
    await expect(page.getByText(/1 game played/)).toBeVisible();
    const recent = page.getByRole("region", { name: "Recent games" });
    await expect(recent.getByText("No finished games yet.")).toHaveCount(0);
    await expect(recent.getByRole("link", { name: "Replay the game K7Q2XZ" })).toBeVisible();
    await expect(page.getByRole("region", { name: "The Ledger" })).toContainText("Your games so far were at friendly tables");
    const own = page.getByRole("region", { name: "Your tables" });
    await expect(own.getByRole("row", { name: /QQ7 R3D/ })).toContainText("Drawn before play");
    await scan(page, "own record after a friendly game");
  });

  test("tells anyone else that friendly games are kept off the public record", async ({ page }) => {
    await afterAFriendlyGame(page);
    await page.goto("/u/ada_l");
    const recent = page.getByRole("region", { name: "Recent games" });
    await expect(recent).toContainText("One more game at friendly tables is kept off the public record.");
    await expect(recent.getByText("No finished games yet.")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "The Ledger" })).toContainText("Seals count here from rated games only");
  });
});

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
    // The figures are the stored history: where the first rated game began, and each range.
    await expect(rating.locator("svg")).toHaveAccessibleName("Rating over 5 rated games, now 1515, likely 1264 to 1766");
    await expect(rating.locator(".rating-band")).toHaveCount(1);
    await rating.getByText("The figures").click();
    const figures = rating.getByRole("table");
    await expect(figures).toContainText("Before the first rated game");
    await expect(figures.getByRole("columnheader", { name: "Likely range" })).toBeVisible();
    await expect(figures.getByRole("row").last()).toContainText("1264 to 1766");
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

  test("a rating history that does not load costs only the chart", async ({ page }) => {
    const server = await recorded(page);
    server.on("GET", /^\/api\/players\/kestrel\/ratings$/i, () => ({ status: 503, body: { error: "unavailable" } }));
    await page.goto("/u/kestrel");
    const rating = page.getByRole("region", { name: "Rating" });
    await expect(rating).toContainText("Ranked 1 on the ladder.");
    await expect(rating.locator(".rating-point")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Recent games" }).getByRole("row")).toHaveCount(6);
  });

  test("a signed-in visitor can report the player, quietly, and only once it is asked for", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    const sent: unknown[] = [];
    server.on("POST", /^\/api\/players\/kestrel\/report$/i, (request) => {
      sent.push({ body: request.postDataJSON(), auth: request.headers()["authorization"] });
      return { status: 202, body: { received: true } };
    });
    server.on("GET", /^\/api\/players\/kestrel$/i, () => ({ body: fixture("profile-kestrel") }));
    server.on("GET", /^\/api\/players\/kestrel\/ratings$/i, () => ({ body: fixture("ratings-kestrel") }));
    await signedIn(page);
    await page.goto("/u/kestrel");
    const report = page.getByRole("region", { name: "Report kestrel" });
    await report.getByRole("button", { name: "Report kestrel to the maintainers" }).click();
    // Focus lands on the first choice; a report needs a reason.
    await expect(report.getByRole("radio", { name: /Cheating/ })).toBeFocused();
    await report.getByRole("button", { name: "Send the report" }).click();
    await expect(report.getByRole("alert")).toHaveText("Choose what the report is about.");
    expect(sent).toEqual([]);
    await report.getByRole("radio", { name: /Abuse/ }).check();
    await report.getByLabel("What happened (optional)").fill("Slurs in public press at table Z2BSVX.");
    await scan(page, "report form");
    await report.getByRole("button", { name: "Send the report" }).click();
    await expect(report.getByRole("status")).toContainText("Report received.");
    expect(sent).toEqual([{ body: { reason: "abuse", note: "Slurs in public press at table Z2BSVX." }, auth: expect.stringMatching(/^Bearer /) }]);
  });

  test("nobody is offered a report about themselves", async ({ page }) => {
    await afterAFriendlyGame(page);
    await signedIn(page);
    await page.goto("/u/ada_l");
    await expect(page.getByRole("heading", { level: 1, name: "ada_l" })).toBeVisible();
    await expect(page.getByRole("button", { name: /to the maintainers/ })).toHaveCount(0);
  });

  test("a visitor with no account is not offered a report", async ({ page }) => {
    await recorded(page);
    await page.goto("/u/kestrel");
    await expect(page.getByRole("heading", { level: 1, name: "kestrel" })).toBeVisible();
    await expect(page.getByRole("button", { name: /to the maintainers/ })).toHaveCount(0);
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

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { SECRET, accountRoutes, fakeServer, fixture } from "./api.js";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("the front door", () => {
  test("arrives drawn: the headline is in the HTML before any script runs", async ({ page }) => {
    await page.route("**/assets/index-*.js", (route) => route.abort());
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Shake hands. Seal it. Break it." })).toBeVisible();
    await expect(page.getByRole("button", { name: /Play now/ })).toBeVisible();
    // The board's preloads (the engine is a megabyte) stay off this page.
    expect(await page.locator('link[href*="cabal_engine_bg"]').count()).toBe(0);
    expect(await page.locator('link[rel="modulepreload"][href*="SandboxPage"]').count()).toBe(0);
  });

  test("hydrates without redrawing, and says what Cabal is", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && !/Service Worker/.test(m.text()) && errors.push(m.text()));
    await page.goto("/");
    const hero = page.locator(".hero-title");
    await expect(hero).toBeVisible();
    const before = await hero.evaluate((el) => {
      (el as HTMLElement & { marked?: boolean }).marked = true;
      return true;
    });
    expect(before).toBe(true);
    // React took the prerendered node over rather than replacing it.
    await page.waitForFunction(() => document.querySelector(".player-button") !== null && (document.querySelector("#root") as HTMLElement).dataset["prerendered"] === "home");
    await page.locator(".player-button").click();
    await expect(page.getByRole("button", { name: "Choose a handle" })).toBeVisible();
    expect(await hero.evaluate((el) => (el as HTMLElement & { marked?: boolean }).marked === true)).toBe(true);
    expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);

    await expect(page.getByRole("list", { name: "The seven great powers" }).getByRole("listitem")).toHaveCount(7);
    for (const name of ["A phase at the table", "The Ledger remembers", "Rivals that never miss a turn", "Rules you can check"]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
  });

  test("never scrolls sideways, and tells the dispatch story in words too", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(4200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator("#theatre-caption")).toContainText("stamped broken");
  });

  test("under reduced motion the story is told at once, with nothing moving", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const animations = await page.evaluate(() => document.getAnimations().length);
    expect(animations).toBe(0);
    await expect(page.locator(".broken-stamp")).toBeVisible();
    await expect(page.locator(".broken-stamp")).toHaveCSS("opacity", "1");
  });

  test("Play now asks for a handle, sets a table against six bots and sits the player down", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    let created: unknown = null;
    server.on("POST", /^\/api\/games$/, (request) => {
      created = { body: request.postDataJSON(), auth: request.headers()["authorization"] };
      return { status: 201, body: { gameId: "K7Q2XZ", token: "K7Q2XZ.seat-token-france", power: "FRANCE" } };
    });
    let started = "";
    server.on("POST", /^\/api\/games\/K7Q2XZ\/start$/, (request) => {
      started = request.headers()["authorization"] ?? "";
      return { body: { ...fixture<Record<string, unknown>>("summary-Z2BSVX"), id: "K7Q2XZ", status: "active", finished: null } };
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Play now/ }).click();
    const dialog = page.getByRole("dialog", { name: "Choose your handle" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("six bots");
    await dialog.getByLabel("Handle").fill("1ada");
    await dialog.getByRole("button", { name: "Take this handle" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("A handle starts with a letter.");
    await dialog.getByLabel("Handle").fill("ada_l");
    await dialog.getByRole("button", { name: "Take this handle" }).click();
    await expect(page).toHaveURL(/\/g\/K7Q2XZ$/);
    expect(created).toEqual({
      body: { settings: { pacing: "live", press: "full", aiFill: true, aiBrain: "bot", visibility: "unlisted" } },
      auth: `Bearer ${SECRET}`,
    });
    expect(started).toBe("Bearer K7Q2XZ.seat-token-france");
    // The seat is kept on the device, and the secret never went into an address.
    const stored = await page.evaluate(() => [localStorage.getItem("cabal.seat.K7Q2XZ"), localStorage.getItem("cabal.player")]);
    expect(stored[0]).toContain("FRANCE");
    expect(stored[1]).toContain("ada_l");
    expect(server.calls.some((c) => c.includes(SECRET))).toBe(false);
  });

  test("Play now says so plainly when the server cannot set the table", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    server.on("POST", /^\/api\/games$/, () => ({ status: 503, body: { error: "down" } }));
    await page.goto("/");
    await page.getByRole("button", { name: /Play now/ }).click();
    await page.getByRole("dialog", { name: "Choose your handle" }).getByRole("button", { name: "Pick one for me" }).click();
    await expect(page.locator(".hero-error")).toHaveText("The game server could not answer. Try again in a moment.");
    await expect(page.getByRole("button", { name: /Play now/ })).toBeEnabled();
  });

  test("Set a table for friends opens the table settings, and the sandbox is one link away", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Set a table for friends" }).first().click();
    await expect(page.getByRole("dialog", { name: "Set a new table" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("link", { name: "Try the sandbox" }).click();
    await expect(page).toHaveURL(/\/sandbox$/);
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
  });

  test("passes an accessibility scan, at rest and with the handle dialog open", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(4200);
    const scan = async (state: string) => {
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${state}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    };
    await scan("front door");
    await page.getByRole("button", { name: /Play now/ }).click();
    await expect(page.getByRole("dialog", { name: "Choose your handle" })).toBeVisible();
    await scan("handle dialog");
  });
});

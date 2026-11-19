import { expect, test } from "@playwright/test";

test.describe("routes", () => {
  test("serves the sandbox at / and at /sandbox", async ({ page }) => {
    for (const path of ["/", "/sandbox"]) {
      await page.goto(path);
      await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".phase-title")).toContainText("Spring 1901");
    }
  });

  const reserved: [string, string][] = [
    ["/games", "The games room is not open yet."],
    ["/ledger", "The Ledger is not open yet."],
    ["/g/K7Q2", "This table is not set yet."],
    ["/u/ada", "No file on this player yet."],
    ["/replay/K7Q2", "This replay is not ready yet."],
  ];

  for (const [path, title] of reserved) {
    test(`${path} is reserved with a not-yet page`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByRole("banner").getByRole("img", { name: "Cabal" })).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
      await page.getByRole("link", { name: "Open the sandbox" }).click();
      await expect(page).toHaveURL(/\/sandbox$/);
      await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
      // The browser's back button returns without a reload.
      await page.goBack();
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    });
  }

  test("an unknown path is a real 404 from the edge, on the site's own page", async ({ page }) => {
    for (const path of ["/g/not/a/route", "/nope", "/apiary", "/sandbox/extra"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("banner").getByRole("img", { name: "Cabal" })).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
      // The static page, not the app shell with a client-side message.
      expect(await page.locator("script[src]").count()).toBe(0);
    }
  });

  test("the app shell and the trust pages come back 200 with the edge's security headers", async ({ page }) => {
    for (const path of ["/", "/sandbox", "/g/K7Q2", "/about", "/privacy"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      const headers = response!.headers();
      expect(headers["content-security-policy"], path).toContain("connect-src 'self'");
      expect(headers["x-content-type-options"], path).toBe("nosniff");
    }
  });

  test("the app and the static pages show the same links and the same footer", async ({ page }, info) => {
    await page.goto("/games");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (info.project.name === "phone") await page.getByRole("button", { name: "Menu" }).click();
    const nav = page.getByRole("navigation", { name: "Site" });
    const app = { links: await nav.locator("a, button").allInnerTexts(), footer: await page.locator("footer.footer").innerText() };
    await page.goto("/about");
    const page2 = { links: await page.getByRole("navigation", { name: "Site" }).locator("a").allInnerTexts(), footer: await page.locator("footer.footer").innerText() };
    expect(page2).toEqual(app);
  });

  test("How to play on a static page opens the board with the dialog up", async ({ page }) => {
    await page.goto("/about");
    await page.getByRole("banner").getByRole("link", { name: "How to play" }).click();
    await expect(page.getByRole("dialog", { name: "How to play" })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/sandbox$/);
  });

  test("the page arrives already showing the top bar and loading screen the app draws", async ({ page }) => {
    const boxes = () =>
      page.evaluate(() =>
        [".topbar", ".topbar .wordmark", ".loading-title", ".loading-line", ".loading-note"].map((selector) => {
          const b = document.querySelector(selector)!.getBoundingClientRect();
          return [b.left, b.top, b.width, b.height].map((n) => Math.round(n));
        }),
      );
    // Without the app's script: what the build wrote into index.html.
    await page.route("**/assets/index-*.js", (route) => route.abort());
    await page.goto("/");
    await expect(page.locator(".app.prerender .loading-note")).toBeVisible();
    const written = await boxes();
    await page.unroute("**/assets/index-*.js");

    // With it, held on the loading screen by a slow engine download.
    await page.route("**/*.wasm", async (route) => {
      await new Promise((done) => setTimeout(done, 2500));
      await route.continue();
    });
    await page.goto("/");
    await expect(page.locator("main.loading-body")).toBeVisible();
    await expect(page.locator(".app.prerender")).toHaveCount(0);
    expect(await boxes()).toEqual(written);
    // And the app does take over.
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
  });

  test("a path the client cannot draw, reached without a page load, says so in the app", async ({ page }) => {
    await page.goto("/games");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      history.pushState(null, "", "/g/not/a/route");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByRole("heading", { level: 1, name: "That province is not on the map." })).toBeVisible();
  });

  for (const path of ["/about", "/contact", "/privacy", "/404.html"]) {
    test(`${path} wears the app's header, wordmark and typefaces`, async ({ page }) => {
      await page.goto(path);
      const banner = page.getByRole("banner");
      await expect(banner.getByRole("img", { name: "Cabal" })).toBeVisible();
      // The same ink bar with the vermilion rule as the board's.
      const bar = await banner.evaluate((el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, rule: style.borderBottomColor };
      });
      expect(bar).toEqual({ background: "rgb(18, 17, 16)", rule: "rgb(217, 79, 48)" });
      // The same links, in the same order, as the app's own top bar.
      await expect(banner.getByRole("navigation", { name: "Site" }).locator("a")).toHaveText(["Sandbox", "How to play", "About", "Contact", "GitHub"]);
      // A static page, not the app: no script runs here.
      expect(await page.locator("script[src]").count()).toBe(0);
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toBeVisible();
      // The brand faces are really loaded, not just named in a font stack.
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.fonts.check('16px "Archivo Black"'))).toBe(true);
      expect(await heading.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Archivo Black");
      await banner.getByRole("link", { name: "Cabal home" }).click();
      await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
    });
  }
});

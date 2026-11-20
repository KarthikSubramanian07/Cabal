/**
 * How a table loads (docs/PERFORMANCE.md, "Opening a table"). On a slow phone the board was the
 * last thing on a long chain: the page, then the summary, then the socket, then the room's code
 * and a second copy of the stylesheet, all while a megabyte of engine competed for the line.
 */
import type { Browser } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { liveTable, sitDown } from "./room.js";

test("a table draws its board from the map, before the engine is fetched, with one stylesheet", async ({ browser, request }, info) => {
  const { host } = await liveTable(request);
  const seen: string[] = [];
  const page = await sitDown(browser, info, host, host.gameId, async (context) => {
    context.on("request", (r) => seen.push(`request ${new URL(r.url()).pathname}`));
    context.on("requestfinished", (r) => seen.push(`done ${new URL(r.url()).pathname}`));
  });
  // The shell asks for the room and the map, not the engine.
  await expect(page.locator('link[rel="modulepreload"][href*="LiveTable-"]')).toHaveCount(1);
  await expect(page.locator('link[rel="modulepreload"][href*="/board-"]')).toHaveCount(1);
  await expect(page.locator('link[href*="cabal_engine_bg"]')).toHaveCount(0);
  await expect(page.locator('link[rel="modulepreload"][href*="SandboxPage-"]')).toHaveCount(0);
  // The engine comes once the map is in, and the orders open when it has.
  await expect(page.getByRole("button", { name: /^Ready for/ })).toBeEnabled({ timeout: 30_000 });
  const mapIn = seen.findIndex((s) => /^done \/assets\/board-[\w-]+\.js$/.test(s));
  const engineAsked = seen.findIndex((s) => /^request \/assets\/cabal_engine_bg-[\w-]+\.wasm$/.test(s));
  expect(mapIn).toBeGreaterThanOrEqual(0);
  expect(engineAsked).toBeGreaterThan(mapIn);
  // The stylesheet is in the page; nothing fetches it again.
  expect(seen.filter((s) => /^request \/assets\/.*\.css$/.test(s))).toEqual([]);
  await page.context().close();
});

test("the socket is dialled while the summary is still on its way", async ({ browser, request }, info) => {
  const { host } = await liveTable(request);
  let summaryAnswered = false;
  let dialledEarly = false;
  const page = await sitDown(browser, info, host, host.gameId, async (context) => {
    // A slow summary: the board must not wait for it to dial.
    await context.route(`**/api/games/${host.gameId}`, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const response = await route.fetch();
        summaryAnswered = true;
        await route.fulfill({ response });
      } catch {
        // The test is over and the page closed.
      }
    });
    context.on("page", (p) =>
      p.on("websocket", () => {
        if (!summaryAnswered) dialledEarly = true;
      }),
    );
  });
  await expect(page.locator("svg.board-live g.unit").first()).toBeAttached();
  expect(dialledEarly).toBe(true);
  await page.context().close();
});

test("a summary that fails after the socket's welcome leaves the live room standing", async ({ browser, request }, info) => {
  const { host } = await liveTable(request);
  let failed = false;
  const page = await sitDown(browser, info, host, host.gameId, async (context) => {
    // The socket gets through and draws the board; the summary, slow, then fails (a 429 from the
    // read limit the two share, or a 5xx): the room must not give way to "not answering".
    await context.route(`**/api/games/${host.gameId}`, async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      failed = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "down" } }) }).catch(() => undefined);
    });
  });
  await expect(page.locator("svg.board-live g.unit").first()).toBeAttached();
  await expect.poll(() => failed, { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByText(/not answering/i)).toHaveCount(0);
  await expect(page.locator("svg.board-live g.unit").first()).toBeAttached();
  // Still live: the seat can say it is ready once the rules are in.
  await expect(page.getByRole("button", { name: /^Ready for/ })).toBeEnabled({ timeout: 30_000 });
  await page.context().close();
});

type Paint = { t: number; size: number; el: string };

/** The first paint and every largest paint of a spectator's load of a table on Lighthouse's phone. */
async function paints(browser: Browser, gameId: string, slow: boolean): Promise<{ first: number; largest: Paint[] }> {
  const context = await browser.newContext({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await context.addInitScript(() => {
    const w = window as unknown as { paints: Paint[] };
    w.paints = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { size: number; element: Element | null })[]) {
        w.paints.push({ t: Math.round(e.startTime), size: e.size, el: e.element?.className ?? "" });
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === "first-contentful-paint") w.paints.push({ t: Math.round(e.startTime), size: 0, el: "first paint" });
    }).observe({ type: "paint", buffered: true });
  });
  const page = await context.newPage();
  if (slow) {
    // A slowed line and a four-times slower processor: React takes over after Inter Tight arrives.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1638.4 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  await page.goto(`/g/${gameId}`, { waitUntil: "commit" });
  await expect(page.locator("svg.board text.label").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(800);
  const all = await page.evaluate(() => (window as unknown as { paints: Paint[] }).paints);
  await context.close();
  return { first: all.find((p) => p.el === "first paint")!.t, largest: all.filter((p) => p.el !== "first paint") };
}

test("a table's largest paint is the shell's loading card in the first frame, not React's copy of it", async ({ browser, request }, info) => {
  test.skip(info.project.name !== "phone", "the phone Lighthouse measures");
  const { host } = await liveTable(request);
  // On a slow phone React paints its copy after Inter Tight has arrived: the copy must not
  // measure larger and count as a new, later largest paint.
  const slow = await paints(browser, host.gameId, true);
  expect(slow.largest.map((p) => p.el)).toEqual(["loading-note"]);
  expect(slow.largest[0]!.t).toBe(slow.first);
  // On a fast one React used to replace the card before its paint was counted, and the browser
  // took React's copy, a few frames later, as the largest paint. Three loads, every one in the first frame.
  for (let i = 0; i < 3; i++) {
    const fast = await paints(browser, host.gameId, false);
    expect(fast.largest.map((p) => p.el)).toEqual(["loading-note"]);
    expect(fast.largest[0]!.t).toBe(fast.first);
  }
});

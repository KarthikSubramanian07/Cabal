/**
 * How a table loads (docs/PERFORMANCE.md, "Opening a table"). On a slow phone the board was the
 * last thing on a long chain: the page, then the summary, then the socket, then the room's code
 * and a second copy of the stylesheet, all while a megabyte of engine competed for the line.
 */
import { expect, test } from "@playwright/test";
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

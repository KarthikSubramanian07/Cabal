/**
 * The clock ticks every second for the whole game. It must redraw only itself: the board (and
 * the table around it) stays put between frames from the server.
 */
import { expect, test } from "@playwright/test";
import { countRenders, renders } from "./renders.js";
import { liveTable, sitDown } from "./room.js";

test("the clock ticks without redrawing the board", async ({ browser, request }, info) => {
  const { host } = await liveTable(request);
  const page = await sitDown(browser, info, host, host.gameId, (context) => countRenders(context, { board: ".board-frame" }));
  const clock = page.locator(".phase-meta .clock");
  // Let the board finish drawing its passes and the first frames settle.
  await expect(page.locator("svg.board text.label").first()).toBeVisible();
  await page.waitForTimeout(1500);

  const before = await renders(page);
  const face = (await clock.textContent()) ?? "";
  await page.waitForTimeout(4200);
  const after = await renders(page);

  // The clock moved on...
  await expect(clock).not.toHaveText(face);
  // ...and the board did not render for it (four ticks would be four renders).
  expect(before.board).toBeGreaterThan(0);
  expect(after.board! - before.board!).toBeLessThanOrEqual(0);
  await page.context().close();
});

/**
 * Orders written with the line down, against the real server: they are kept on the device, so
 * leaving the room (here, a reload) before the connection returns does not lose them. When the
 * line is back they are put back on the desk and filed, another device of the same seat sees
 * them, and the device lets go of its copy.
 */
import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { liveTable, sitDown, tab, titleCase } from "./room.js";

/** Two orders any power can give in the spring of 1901. */
const SPRING: Record<string, string[]> = {
  AUSTRIA: ["A VIE - GAL", "F TRI - ALB"],
  ENGLAND: ["F LON - NTH", "A LVP - YOR"],
  FRANCE: ["A PAR - BUR", "F BRE - MAO"],
  GERMANY: ["A BER - KIE", "A MUN - RUH"],
  ITALY: ["A ROM - APU", "F NAP - ION"],
  RUSSIA: ["A MOS - UKR", "F SEV - BLA"],
  TURKEY: ["A CON - BUL", "F ANK - BLA"],
};

test("orders written offline survive leaving the room and are filed when the line is back", async ({ browser, request }, info) => {
  const { host } = await liveTable(request);
  const orders = SPRING[host.power]!;
  // The game socket goes through here: while `cut`, a socket opens but nothing answers it.
  let cut = false;
  const sockets: WebSocketRoute[] = [];
  const page = await sitDown(browser, info, host, host.gameId, (context) =>
    context.routeWebSocket(/\/api\/games\/[^/]+\/ws/, (ws) => {
      if (cut) return;
      sockets.push(ws);
      ws.connectToServer();
    }),
  );
  const context = page.context();
  const list = page.getByRole("group", { name: `${titleCase(host.power)} orders` });
  const syncLine = page.locator(".sync-line");
  await tab(page, "Orders");
  await expect(syncLine).toHaveText("No orders on file: your units hold.", { timeout: 30_000 });

  // The line goes down.
  cut = true;
  for (const ws of sockets.splice(0)) await ws.close();
  await context.setOffline(true);
  await expect(page.locator(".wire-down")).toContainText("You are offline.");

  const box = page.getByRole("combobox", { name: "Write an order" });
  await box.fill(orders.join("; "));
  await box.press("Enter");
  for (const o of orders) await expect(list).toContainText(o);
  await expect(syncLine).toHaveText("Your orders are kept on this device and filed when the connection is back.");

  // Leave before the line returns: the page is loaded afresh while the game socket is still down.
  await context.setOffline(false);
  await page.reload();
  // Without the socket the table cannot be drawn (its board comes in the welcome), but the
  // orders are still on the device.
  await expect(page.getByRole("status").filter({ hasText: "Setting up the board." })).toBeVisible();
  const key = `cabal.draft.${host.gameId}.${host.power}`;
  const kept = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);
  expect(Object.values(kept?.book ?? {}).sort()).toEqual([...orders].sort());

  // The line is back: the orders are on the desk again and go on file.
  cut = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("svg.board text.label").first()).toBeVisible({ timeout: 30_000 });
  await tab(page, "Orders");
  for (const o of orders) await expect(list).toContainText(o, { timeout: 30_000 });
  await expect(syncLine).toHaveText("Your orders are on file. Units without one hold.", { timeout: 20_000 });
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key)).toBeNull();

  // The server has them: the same seat on another device finds them there.
  const other = await sitDown(browser, info, host, host.gameId);
  await tab(other, "Orders");
  const theirs = other.getByRole("group", { name: `${titleCase(host.power)} orders` });
  for (const o of orders) await expect(theirs).toContainText(o, { timeout: 20_000 });
  await other.context().close();
  await context.close();
});

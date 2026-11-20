/**
 * A whole game on two phones, by touch alone, against the real server and the bot in the five
 * other seats: no keyboard, no typed orders, no mouse. Germany and Russia are human, so what
 * happens between them is certain whatever the bot does elsewhere (no bot unit can reach the
 * provinces involved in 1901):
 *
 *   Spring 1901  Germany A BER - PRU, F KIE - DEN, A MUN holds; Russia A MOS - LVN.
 *   Fall 1901    Russia A WAR - PRU supported by A LVN; Germany's A PRU and F DEN hold.
 *   Retreat      Germany's dislodged A PRU retreats to Berlin.
 *   Winter 1901  Germany has gained Denmark, and builds an army in Kiel from the menu.
 *   Spring 1902  Both vote for a draw, and the game is over for both.
 *
 * Every order is tapped on the map, every button is tapped with a finger.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { tap } from "../e2e/helpers.js";
import { primary, scan, sitDown, tableAs } from "./room.js";

/** A finger on a button. */
const press = (target: Locator) => target.tap();

async function sheet(page: Page, open: boolean) {
  const bar = page.locator(".sheet-bar");
  if ((await bar.getAttribute("aria-expanded")) !== String(open)) await press(bar);
}

async function tabTo(page: Page, name: RegExp) {
  await sheet(page, true);
  await press(page.getByRole("tab", { name }));
}

/** Tap Ready on both phones (a seat with nothing to do waits), then Continue once the phase resolves. */
async function resolve(pages: Page[], next: RegExp) {
  for (const p of pages) {
    await sheet(p, false);
    const label = (await primary(p).innerText()).trim();
    if (label.startsWith("Ready for")) await press(primary(p));
  }
  for (const p of pages) {
    await expect(primary(p)).toHaveText(next, { timeout: 30_000 });
  }
}

/** The seat's orders as written, in any order. */
async function given(page: Page): Promise<string[]> {
  return (await page.locator(".orders .row.given code").allInnerTexts()).map((t) => t.trim()).sort();
}

async function carryOn(pages: Page[]) {
  for (const p of pages) {
    if (/^(Continue|Next)/.test((await primary(p).innerText()).trim())) await press(primary(p));
  }
}

test.describe("a whole game by touch, live", () => {
  test("movement, a retreat, a build and a draw, tapped on two phones", async ({ browser, request }, info) => {
    test.skip(info.project.name !== "phone", "a game played with a finger");
    test.slow();
    const { host, guest } = await tableAs(request, "GERMANY", "RUSSIA");
    const de = await sitDown(browser, info, host, host.gameId);
    const ru = await sitDown(browser, info, guest, guest.gameId);
    const both = [de, ru];
    // Nothing on either phone is ever typed into.
    for (const p of both) {
      await p.evaluate(() => {
        (window as unknown as { typed: number }).typed = 0;
        document.addEventListener("keydown", () => (window as unknown as { typed: number }).typed++, true);
      });
    }
    for (const p of both) await expect(p.getByRole("heading", { level: 1 })).toContainText("Spring 1901, movement");
    // The orders open once the rules are in.
    for (const p of both) await expect(p.locator(".toolbar").getByRole("button", { name: "Move" })).toBeVisible({ timeout: 30_000 });

    // ---- Spring 1901
    await tap(de, "BER");
    await tap(de, "PRU");
    await tap(de, "KIE");
    await tap(de, "DEN");
    await tap(de, "MUN");
    await tap(de, "MUN");
    await tap(ru, "MOS");
    await tap(ru, "LVN");
    await tabTo(de, /^Orders/);
    await expect.poll(() => given(de)).toEqual(["A BER - PRU", "A MUN H", "F KIE - DEN"]);
    await resolve(both, /^Continue to Fall 1901$/);
    await carryOn(both);

    // ---- Fall 1901: Russia takes Prussia with support.
    await expect(ru.getByRole("heading", { level: 1 })).toContainText("Fall 1901, movement");
    await tap(ru, "WAR");
    await tap(ru, "PRU");
    await tap(ru, "LVN");
    await press(ru.locator(".toolbar").getByRole("button", { name: /^Support/ }));
    await tap(ru, "WAR");
    await tap(ru, "PRU");
    await tabTo(ru, /^Orders/);
    await expect.poll(() => given(ru)).toEqual(["A LVN S A WAR - PRU", "A WAR - PRU"]);
    await tap(de, "PRU");
    await tap(de, "PRU");
    await resolve(both, /^Continue to Fall 1901 retreats$/);
    await tabTo(de, /^Results/);
    await expect(de.getByRole("group", { name: "Adjudication results" })).toContainText("A PRU was dislodged");
    await carryOn(both);

    // ---- The retreat: tap the dislodged army, then Berlin.
    await expect(de.getByRole("heading", { level: 1 })).toContainText("Fall 1901, retreats");
    await sheet(de, false);
    await tap(de, "PRU");
    await expect(de.locator(".toolbar .hint")).toContainText("A PRU");
    await tap(de, "BER");
    await tabTo(de, /^Orders/);
    await expect.poll(() => given(de)).toEqual(["A PRU R BER"]);
    await resolve(both, /^Continue to Winter 1901 builds$/);
    await carryOn(both);

    // ---- Winter 1901: an army in Kiel, chosen from the menu over the map.
    await expect(de.getByRole("heading", { level: 1 })).toContainText("Winter 1901, adjustments");
    await sheet(de, false);
    await tap(de, "KIE");
    const menu = de.getByRole("menu", { name: "Build in KIE" });
    await expect(menu).toBeVisible();
    await press(menu.getByRole("menuitem", { name: "A KIE B" }));
    await tabTo(de, /^Orders/);
    await expect.poll(() => given(de)).toEqual(["A KIE B"]);
    await scan(de, "a winter on a phone");
    await resolve(both, /^Continue to Spring 1902$/);
    await carryOn(both);
    await expect(de.getByRole("heading", { level: 1 })).toContainText("Spring 1902, movement");
    // The new army stands in Kiel and the retreated one in Berlin.
    await tabTo(de, /^Orders/);
    const units = (await de.locator(".orders .row code").allInnerTexts()).map((t) => t.trim()).sort();
    expect(units).toEqual(["A BER", "A KIE", "A MUN", "F DEN"]);

    // ---- The draw, voted with a finger on both phones.
    await tabTo(de, /^Table/);
    await press(de.getByRole("button", { name: "Vote for a draw" }));
    await tabTo(ru, /^Table/);
    await expect(ru.locator(".draw-tally")).toHaveText("1 of 2 for a draw. It passes when both say yes.");
    await press(ru.getByRole("button", { name: "Vote for a draw" }));
    for (const p of both) {
      await sheet(p, false);
      await expect(primary(p)).toHaveText("See the final scores", { timeout: 30_000 });
      await press(primary(p));
      await expect(p.getByRole("heading", { name: /^A draw/ })).toBeVisible();
      await expect(p.getByRole("table", { name: "Final scores" })).toBeVisible();
      expect(await p.evaluate(() => (window as unknown as { typed: number }).typed)).toBe(0);
    }
    for (const p of both) await p.context().close();
  });
});

/**
 * The board inside a live room by keyboard, against the real server: the choices under the map
 * are named for what they do, focus moves to the next choices after each one instead of falling
 * to the page, the order lands, and the positions are there as text for anyone not reading the
 * map.
 */
import { expect, test } from "@playwright/test";
import { liveTable, scan, sitDown, tab, titleCase } from "./room.js";

test.describe("the room by keyboard, live", () => {
  test("orders a unit from the choices with focus kept on the next choice, and reads the board as text", async ({ browser, request }, info) => {
    test.skip(info.project.name !== "desktop", "a keyboard walk");
    const { host } = await liveTable(request);
    const page = await sitDown(browser, info, host, host.gameId);
    const choices = page.getByRole("region", { name: new RegExp(`^${titleCase(host.power)}: choose a unit`, "i") });
    await expect(choices).toBeVisible({ timeout: 30_000 });

    // Every unit is offered by name: "A PAR: Army Paris".
    const first = choices.getByRole("button").first();
    const unit = (await first.innerText()).split(":")[0]!.trim();
    expect(unit).toMatch(/^[AF] [A-Z]{3}/);
    await expect(first).toHaveAccessibleName(new RegExp(`^${unit}: (Army|Fleet) `));

    await first.focus();
    await page.keyboard.press("Enter");
    // The unit's own choices replace the list, and focus is on the first of them, not the page.
    const focused = page.locator(":focus");
    await expect(focused).toHaveClass(/choice/);
    await expect(focused).toHaveText(/^(Move|Hold|Support)/);
    await expect(page.locator(".toolbar .hint")).toContainText(unit);
    await page.keyboard.press("Enter");
    // The order is written and focus is back on the units to order, not on the page.
    await expect(page.locator(".choices button:focus")).toHaveCount(1);
    await expect(page.locator(":focus")).toHaveText(/^[AF] [A-Z]{3}.*: (Army|Fleet) /);
    await tab(page, "Orders");
    await expect(page.locator(".orders .row.given code")).toHaveCount(1);
    await expect(page.locator(".orders .row.given code").first()).toContainText(unit);

    // The positions as text, named the way the choices name them.
    const text = page.locator("details.board-text");
    await text.locator("summary").click();
    await expect(text.getByRole("heading", { name: titleCase(host.power) })).toBeVisible();
    await expect(text).toContainText(`${unit},`);
    await scan(page, "room with the board as text open");
    await page.context().close();
  });
});

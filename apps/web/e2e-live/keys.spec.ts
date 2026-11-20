/**
 * The board inside a live room by keyboard, against the real server: the choices under the map
 * are named for what they do, focus moves to the next choices after each one instead of falling
 * to the page, the order lands, and the positions are there as text for anyone not reading the
 * map.
 */
import { expect, test } from "./fixtures.js";
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

  test("closing a sketch by Discard or by using it hands focus back to What if, not the page", async ({ browser, request }, info) => {
    test.skip(info.project.name !== "desktop", "a keyboard walk");
    const { host } = await liveTable(request);
    const page = await sitDown(browser, info, host, host.gameId);
    const whatIf = page.locator(".toolbar").getByRole("button", { name: "What if" });
    await expect(whatIf).toBeVisible({ timeout: 30_000 });
    const panel = page.getByRole("region", { name: "What if" });

    /** Open a sketch and write one order in it, by keyboard alone. */
    const sketchOne = async () => {
      await whatIf.focus();
      await page.keyboard.press("Enter");
      await expect(whatIf).toHaveAttribute("aria-pressed", "true");
      await page.locator(".choices button:not(:disabled)").first().focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".choices button.choice:focus")).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("button", { name: "Use my sketched orders" })).toBeEnabled();
    };
    const focusedTag = () => page.evaluate(() => document.activeElement?.tagName ?? "none");

    await tab(page, "Orders");
    await sketchOne();
    await panel.getByRole("button", { name: "Discard" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
    expect(await focusedTag()).not.toBe("BODY");
    await expect(whatIf).toBeFocused();
    await expect(whatIf).toHaveAttribute("aria-pressed", "false");

    await sketchOne();
    await panel.getByRole("button", { name: "Use my sketched orders" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
    expect(await focusedTag()).not.toBe("BODY");
    await expect(whatIf).toBeFocused();
    await expect(page.locator(".orders .row.given code")).toHaveCount(1);
    await page.context().close();
  });

  test("on a phone, closing a sketch keeps focus in the sheet rather than on the toolbar under it", async ({ browser, request }, info) => {
    test.skip(info.project.name !== "phone", "the sheet covers the toolbar on a phone");
    const { host } = await liveTable(request);
    const page = await sitDown(browser, info, host, host.gameId);
    const whatIf = page.locator(".toolbar").getByRole("button", { name: "What if" });
    await expect(whatIf).toBeVisible({ timeout: 30_000 });
    await whatIf.focus();
    await page.keyboard.press("Enter");
    await tab(page, "Orders");
    const panel = page.getByRole("region", { name: "What if" });
    await panel.getByRole("button", { name: "Discard" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^Orders/ })).toBeFocused();
    await page.context().close();
  });
});

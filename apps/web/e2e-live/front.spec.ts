/**
 * The front door to the record, against the real server: a newcomer presses Play now, chooses a
 * handle, plays a phase against six bots, readies (and is offered notifications, never asked
 * unprompted), votes the game to a draw, and then finds the finished game on their record and
 * plays it back.
 */
import { expect, test } from "@playwright/test";
import { chooseHandle, primary, scan, tab, uniqueHandle } from "./room.js";

test.describe("the front door, live", () => {
  test("Play now, a phase against six bots, a draw, then the record and the replay", async ({ page }) => {
    test.slow(); // a whole short game and four pages
    // The local server has no VAPID keys; say it does, so the offer can be made (it is only made
    // where the server can send).
    await page.route("**/api/push/key", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" }) }));
    await page.goto("/");
    await page.getByRole("button", { name: /Play now/ }).click();
    const handle = uniqueHandle("nell");
    await chooseHandle(page, handle);

    // Sat down at a started table: the board, the seat strip, and six seats played by the bot.
    await expect(page).toHaveURL(/\/g\/[A-Z2-9]{6}$/, { timeout: 20_000 });
    const code = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.locator("svg.board text.label").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Spring 1901, movement");
    await expect(page.getByRole("list", { name: "Seats this phase" }).getByText(/played by the bot/)).toHaveCount(6);
    await expect(page.locator(".player-button")).toHaveAccessibleName(`Your account, ${handle}`);

    // Ready with every unit holding: the phase resolves at once, the bots being ready already.
    await tab(page, "Orders");
    await page.getByRole("button", { name: "Hold the rest" }).click();
    await expect(page.locator(".sync-line")).toHaveText("Your orders are on file with the server.");
    await primary(page).click();
    // The offer comes after the player readied, and only says what it would do.
    await expect(page.locator(".notify-offer")).toBeVisible();
    await expect(page.locator(".notify-offer")).toContainText("Want a nudge on this device");
    await page.locator(".notify-offer").getByRole("button", { name: "Not now" }).click();
    await expect(page.locator(".notify-offer")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Fall 1901", { timeout: 20_000 });

    // The only person at the table votes for a draw, and the game is over.
    await tab(page, "Table");
    await page.getByRole("button", { name: "Vote for a draw" }).click();
    await expect(primary(page)).toHaveText("See the final scores", { timeout: 20_000 });

    // The record lists the game, unrated, with its replay.
    await page.goto(`/u/${handle}`);
    await expect(page.getByRole("heading", { level: 1, name: handle })).toBeVisible();
    await expect(page.getByRole("button", { name: "Your account", exact: true })).toBeVisible();
    const recent = page.getByRole("region", { name: "Recent games" });
    await expect(recent.getByRole("row")).toHaveCount(2);
    await expect(recent).toContainText("Unrated");
    await scan(page, "profile, live");
    // An unlisted game's code is shown to its own player.
    await recent.getByRole("link", { name: `Replay the game ${code}` }).click();
    await expect(page).toHaveURL(new RegExp(`/replay/${code}$`));
    await expect(page.getByRole("heading", { level: 1, name: /^Replay of table/ })).toBeAttached({ timeout: 20_000 });
    await expect(page.locator("svg.board")).toBeVisible();
    await scan(page, "replay, live");

    // The Ledger reads from the same server.
    await page.goto("/ledger");
    await expect(page.getByRole("heading", { level: 1, name: "The Ledger" })).toBeVisible();
    await expect(page.getByRole("tabpanel")).toBeVisible();
  });
});

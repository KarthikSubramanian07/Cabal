/**
 * Leaving for good, against the real server: a newcomer plays, then deletes the account from the
 * account card. The seat they held becomes a ghost the bot plays, their record is gone, and the
 * device is signed out.
 */
import { expect, test } from "./fixtures.js";
import { chooseHandle, uniqueHandle } from "./room.js";

test.describe("deleting an account, live", () => {
  test("the seat becomes a ghost, the record goes, and the device lets go", async ({ page, request }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Play now/ }).click();
    const handle = uniqueHandle("gone");
    await chooseHandle(page, handle);
    await expect(page).toHaveURL(/\/g\/[A-Z2-9]{6}$/, { timeout: 20_000 });
    const code = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Spring 1901, movement", { timeout: 30_000 });
    const seat = (await (await request.get(`/api/games/${code}`)).json()) as { seats: { power: string; handle: string | null }[] };
    const power = seat.seats.find((s) => s.handle === handle)!.power;

    await page.locator(".player-button").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    const section = card.getByRole("region", { name: "Delete the account" });
    await section.getByRole("button", { name: "Delete this account" }).click();
    await section.getByLabel(`Type ${handle} to confirm`).fill(handle);
    await section.getByRole("button", { name: "Delete for good" }).click();
    await expect(card.getByRole("status")).toContainText("The account is deleted.");
    await card.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account");

    // The seat is a ghost in civil disorder. (With nobody else at this table, the game then ends by
    // its own rule rather than playing on for nobody.)
    const after = (await (await request.get(`/api/games/${code}`)).json()) as { status: string; seats: { power: string; kind: string; name: string | null; handle: string | null }[] };
    expect(after.seats.find((s) => s.power === power)).toMatchObject({ kind: "civil_disorder", name: "Ghost", handle: null });
    expect((await request.get(`/api/players/${handle}`)).status()).toBe(404);
    expect(await page.evaluate(() => localStorage.getItem("cabal.player"))).toBeNull();
    expect(await page.evaluate((c) => localStorage.getItem(`cabal.seat.${c}`), code)).toBeNull();
  });
});

/**
 * The social layer in a live room, against a real cabal-server: news from out of sight arrives as
 * a dispatch slip that opens the thread it is about, a reply quotes the message it answers in the
 * original's own words, and each signed-in player's trust and record are a tap away from their seat.
 */
import { expect, test } from "@playwright/test";
import { type Seat, liveTable, scan, sitDown, tab, titleCase, uniqueHandle } from "./room.js";

test.describe("the social layer, live", () => {
  test("a dispatch slip brings a private message in, and the reply quotes it", async ({ browser, request }, info) => {
    const { host, guest } = await liveTable(request);
    const ada = await sitDown(browser, info, host, host.gameId);
    const bea = await sitDown(browser, info, guest, guest.gameId);
    const Host = titleCase(host.power);
    const Guest = titleCase(guest.power);

    // Ada writes to Bea while Bea is busy with her orders.
    await tab(bea, "Orders");
    await tab(ada, "Press");
    await ada.getByRole("button", { name: Guest }).click();
    await ada.getByLabel(`Message ${Guest}`).fill("Keep out of the Channel this year and I keep out of Belgium.");
    await ada.getByLabel(`Message ${Guest}`).press("Enter");

    const board = bea.getByRole("region", { name: "News from the table" });
    const slip = board.getByRole("listitem").filter({ hasText: `Dispatch from ${Host}` });
    await expect(slip).toContainText("Keep out of the Channel this year");
    // Ada is reading that very thread: her own words bring her no slip.
    await expect(ada.getByRole("region", { name: "News from the table" })).toHaveCount(0);
    await scan(bea, "a dispatch slip over the room");

    // The slip opens the thread it is about, and goes.
    await slip.getByRole("button", { name: "Read it" }).click();
    const thread = bea.getByRole("log", { name: `Private thread with ${Host}` });
    await expect(thread).toBeVisible();
    await expect(thread).toBeFocused();
    await expect(slip).toHaveCount(0);

    // Bea quotes it in her answer.
    await thread.getByRole("button", { name: `Quote this message from ${Host}` }).click();
    const composer = bea.getByLabel(`Message ${Host}`);
    await expect(composer).toBeFocused();
    await expect(bea.locator(".quote-slip")).toContainText(`Quoting ${Host}`);
    await composer.fill("Agreed, for this year.");
    await composer.press("Enter");
    await expect(bea.locator(".quote-slip")).toHaveCount(0);

    // Ada reads the answer with her own words set into it, as the server holds them.
    const adaThread = ada.getByRole("log", { name: `Private thread with ${Guest}` });
    const reply = adaThread.locator(".dispatch").filter({ hasText: "Agreed, for this year." });
    await expect(reply.locator(".dispatch-quote")).toContainText(Host);
    await expect(reply.locator(".dispatch-quote")).toContainText("Keep out of the Channel this year and I keep out of Belgium.");
    await scan(ada, "press with a quote");
  });

  test("each signed-in seat shows its trust and leads to the player's record", async ({ browser, request }, info) => {
    const make = async (stem: string) => (await (await request.post("/api/players", { data: { handle: uniqueHandle(stem) } })).json()) as { player: { id: string; handle: string }; secret: string };
    const ann = await make("Ann");
    const bob = await make("Bob");
    const auth = (secret: string) => ({ authorization: `Bearer ${secret}` });
    const made = await (await request.post("/api/games", { data: { name: ann.player.handle, settings: { pacing: "live", aiFill: true, visibility: "unlisted" } }, headers: auth(ann.secret) })).json();
    const joined = await (await request.post(`/api/games/${made.gameId}/join`, { data: { name: bob.player.handle }, headers: auth(bob.secret) })).json();
    expect((await request.post(`/api/games/${made.gameId}/start`, { headers: { authorization: `Bearer ${made.token}` } })).ok()).toBe(true);
    const seat: Seat = { gameId: made.gameId, power: made.power, token: made.token, name: ann.player.handle };
    const page = await sitDown(browser, info, seat, made.gameId);
    const Bob = titleCase(joined.power);

    // The powers on the Table tab: Bob's place card carries his trust from the Ledger.
    await tab(page, "Table");
    const card = page.locator(".seats-section .place").filter({ hasText: bob.player.handle });
    await expect(card.locator(".place-trust")).toHaveText("50% trust, no promises yet");
    // In the narrow sidebar the Host and You marks take their own line above the power's name, so
    // a long name (Austria, Germany) is never printed under them.
    const mine = page.locator(".seats-section .place.mine");
    const marks = (await mine.locator(".place-marks").boundingBox())!;
    const name = (await mine.locator(".place-power").boundingBox())!;
    expect(marks.y + marks.height).toBeLessThanOrEqual(name.y + 1);
    // A seat the bot plays has no record and no trust.
    await expect(page.locator(".seats-section .place").filter({ hasText: "Played by the bot" }).first().locator(".place-trust")).toHaveCount(0);

    // In the seat strip, Bob's whole cell is the way to his record, and big enough to hit.
    const strip = page.getByRole("list", { name: "Seats this phase" }).filter({ visible: true });
    const link = strip.getByRole("link", { name: new RegExp(`^${Bob}, ${bob.player.handle}.*Trust 50%.*${bob.player.handle}'s record\\.$`) });
    const box = (await link.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
    // Bots' cells are not links.
    await expect(strip.getByRole("link")).toHaveCount(2);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/u/${bob.player.handle}$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(bob.player.handle);
  });
});

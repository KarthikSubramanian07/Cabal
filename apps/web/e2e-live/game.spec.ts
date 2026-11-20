/**
 * A whole live game against a real cabal-server (see playwright.live.config.ts): two people on two
 * devices and the bot in the five other seats. They write orders on the map and as text, talk in
 * private, one seals a pledge, phases resolve with receipts, they vote a draw, and both read the
 * final scores and the Ledger. A third device watches.
 */
import { expect, test } from "@playwright/test";
import { tap } from "../e2e/helpers.js";
import { closeSheet, liveTable, primary, scan, sitDown, tab, titleCase } from "./room.js";

test.describe("the game room, live", () => {
  test("two players order, talk, seal a pledge, see it kept, play on and vote a draw", async ({ browser, request }, info) => {
    test.slow(); // three devices, several phases, accessibility scans
    const { host, guest } = await liveTable(request);
    const ada = await sitDown(browser, info, host, host.gameId);
    const bea = await sitDown(browser, info, guest, guest.gameId);
    const Host = titleCase(host.power);
    const Guest = titleCase(guest.power);

    // Both are in the room: the phase, their own seat, and the bot at the five other seats.
    for (const [p, me] of [[ada, Host], [bea, Guest]] as const) {
      await expect(p.getByRole("heading", { level: 1 })).toContainText("Spring 1901, movement");
      await expect(p.locator(".you-as")).toHaveText(me);
      await expect(p.getByRole("list", { name: "Seats this phase" }).getByText(/played by the bot/)).toHaveCount(5);
    }
    await scan(ada, "game room, orders");

    // Ada orders on the map: a unit tapped twice holds.
    await tab(ada, "Orders");
    const adaUnit = (await ada.locator(".orders .row code").first().innerText()).trim();
    await closeSheet(ada);
    const province = adaUnit.split(" ")[1]!.slice(0, 3);
    await tap(ada, province);
    await tap(ada, province);
    await tab(ada, "Orders");
    await expect(ada.locator(".orders .row.given code").first()).toHaveText(`${adaUnit} H`);
    // One unit of several: the desk says the rest will hold.
    await expect(ada.locator(".sync-line")).toHaveText("Your orders are on file. Units without one hold.");
    // Bea's seat strip sees that Ada's orders are in, never what they are.
    await expect(bea.getByRole("list", { name: "Seats this phase" })).toContainText(`${Host}, Ada: orders in, not ready yet.`);

    // Bea writes hers as text.
    await tab(bea, "Orders");
    const beaUnit = (await bea.locator(".orders .row code").first().innerText()).trim();
    await bea.getByRole("combobox").fill(`${beaUnit} H`);
    await bea.getByRole("combobox").press("Enter");
    await expect(bea.locator(".orders .row.given code").first()).toHaveText(`${beaUnit} H`);

    // Ada writes to Bea in private, with her order under a seal.
    await tab(ada, "Press");
    await ada.getByRole("button", { name: Guest }).click();
    await ada.getByLabel(`Message ${Guest}`).fill("I hold. Sealed, so you can check me when the phase resolves.");
    await ada.getByRole("button", { name: "Attach a seal" }).click();
    await ada.getByRole("checkbox", { name: `${adaUnit} H` }).check();
    await ada.getByRole("button", { name: "Send under seal" }).click();
    const adaThread = ada.getByRole("log", { name: `Private thread with ${Guest}` });
    await expect(adaThread.locator(".seal-card")).toContainText("Sealed pledge");
    // The pledger reads her own orders under the seal.
    await expect(adaThread.locator(".seal-orders")).toContainText(`${adaUnit} H`);
    await scan(ada, "press with a seal");

    // Bea sees one unread dispatch, opens it, and sees only the wax.
    await tab(bea, "Press");
    await expect(bea.getByRole("button", { name: new RegExp(`^${Host}\\W*1 unread`) })).toBeVisible();
    await bea.getByRole("button", { name: Host }).click();
    const beaThread = bea.getByRole("log", { name: `Private thread with ${Host}` });
    await expect(beaThread).toContainText("I hold.");
    await expect(beaThread.locator(".seal-card")).toContainText("The orders stay under the seal until the phase resolves.");
    await expect(beaThread.locator(".seal-orders")).toHaveCount(0);
    await bea.getByLabel(`Message ${Host}`).fill("Then I hold too.");
    await bea.getByLabel(`Message ${Host}`).press("Enter");
    await expect(adaThread).toContainText("Then I hold too.");
    await expect(bea.getByRole("button", { name: new RegExp(`^${Host}\\W*1 unread`) })).toHaveCount(0);

    // Public press at the table, read by both.
    await bea.getByRole("button", { name: "The table" }).click();
    await bea.getByLabel("Message the table").fill("Good evening, Europe.");
    await bea.getByRole("button", { name: "Send", exact: true }).click();
    await ada.getByRole("button", { name: "The table" }).click();
    await expect(ada.getByRole("log", { name: /The table/ })).toContainText("Good evening, Europe.");

    // Both are ready: the phase resolves at once, with the engine's results.
    await expect(primary(ada)).toHaveText("Ready for Spring 1901 movement");
    await primary(ada).click();
    await expect(primary(ada)).toHaveText("Ready. Take it back");
    await expect(bea.getByRole("list", { name: "Seats this phase" })).toContainText(`${Host}, Ada: orders in and ready.`);
    await primary(bea).click();
    for (const p of [ada, bea]) {
      await expect(primary(p)).toHaveText(/^Continue to Fall 1901/, { timeout: 20_000 });
      await tab(p, "Results");
      await expect(p.getByRole("group", { name: "Adjudication results" })).toBeVisible();
    }
    await scan(bea, "results");

    // The receipt is stamped on Bea's side, and her device opens the seal itself.
    await tab(bea, "Press");
    await bea.getByRole("button", { name: Host }).click();
    const seal = beaThread.locator(".seal-card");
    await expect(seal.getByRole("img", { name: "Receipt: Kept" })).toBeVisible();
    await expect(seal.locator(".seal-orders")).toContainText(`${adaUnit} H`);
    await expect(seal).toContainText("Opened on this device: the revealed orders and nonce make exactly this seal.");
    await expect(seal).toContainText("The receipt agrees with the adjudication this device received.");

    // On to the next phases. Ready files every unit's orders first, so nobody is counted as silent.
    for (let i = 0; i < 4; i++) {
      for (const p of [ada, bea]) {
        if (/^(Continue|Next)/.test((await primary(p).innerText()).trim())) await primary(p).click();
      }
      if (/Spring 1902/.test((await ada.getByRole("heading", { level: 1 }).innerText()).trim())) break;
      for (const p of [ada, bea]) {
        const label = (await primary(p).innerText()).trim();
        if (label.startsWith("Ready for")) await primary(p).click();
      }
      await expect(primary(ada)).not.toHaveText(/^Ready\. Take it back/, { timeout: 20_000 });
    }
    await expect(ada.getByRole("heading", { level: 1 })).toContainText("Spring 1902, movement");
    // A winter with nothing to build resolves at once: its results can still be on show when the
    // loop ends. Back to the live board on both, as a player would, before the vote.
    for (const p of [ada, bea]) {
      while (/^(Continue|Next)/.test((await primary(p).innerText()).trim())) await primary(p).click();
      await expect(primary(p)).toHaveText(/^Ready for Spring 1902/);
    }
    // Neither player missed a turn.
    for (const p of [ada, bea]) await expect(p.getByRole("list", { name: "Seats this phase" }).getByText(/civil disorder|missed turns/)).toHaveCount(0);

    // A spectator watches the same table: the board and the public press, no orders, no private threads.
    const eve = await sitDown(browser, info, null, host.gameId);
    await expect(eve.locator(".watching")).toHaveText("Watching");
    await tab(eve, "Press");
    await expect(eve.getByRole("log", { name: /The table/ })).toContainText("Good evening, Europe.");
    await expect(eve.getByRole("log", { name: /The table/ })).not.toContainText("I hold.");
    await expect(eve.getByRole("button", { name: Host })).toHaveCount(0);
    await scan(eve, "spectator");

    // The draw: Ada votes for it, Bea sees the tally, then agrees, and the game ends for everyone.
    await tab(ada, "Table");
    await ada.getByRole("button", { name: "Vote for a draw" }).click();
    await tab(bea, "Table");
    await expect(bea.locator(".draw-tally")).toHaveText("1 of 2 for a draw. It passes when both say yes.");
    await bea.getByRole("button", { name: "Vote for a draw" }).click();
    for (const p of [ada, bea, eve]) {
      await expect(primary(p)).toHaveText("See the final scores", { timeout: 20_000 });
      await primary(p).click();
      await expect(p.getByRole("heading", { name: /^A draw/ })).toBeVisible();
      await expect(p.getByRole("table", { name: "Final scores" })).toBeVisible();
    }
    // The Ledger lists the seal, kept, and it opens on this device too.
    const entry = bea.locator(".ledger-entry").first();
    await expect(entry).toContainText(`${Host} to ${Guest}`);
    await expect(entry).toContainText("kept");
    await expect(entry).toContainText("opens on this device.");
    await scan(bea, "game over");
    for (const p of [ada, bea, eve]) await p.context().close();
  });
});

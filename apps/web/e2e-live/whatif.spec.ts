/**
 * What if inside a live room, against the real server: a seat sketches its own move and guesses a
 * neighbour's, the engine on the device predicts the bounce, and nothing is sent while it does.
 * The sketch then becomes the seat's orders, the neighbour really makes that move, and the
 * adjudication agrees with the prediction, with the same "Why?" in the results.
 */
import { expect, test } from "@playwright/test";
import { tap } from "../e2e/helpers.js";
import { closeSheet, framesSent, primary, scan, sitDown, tab, tableAs } from "./room.js";

test.describe("what if, live", () => {
  test("predicts a bounce without sending a frame, and the adjudication agrees", async ({ browser, request }, info) => {
    test.slow();
    const { host, guest } = await tableAs(request, "FRANCE", "GERMANY");
    let sent: string[] | null = null;
    const ada = await sitDown(browser, info, host, host.gameId, async (context) => {
      // The table's own page only: the accessibility scan opens a blank one of its own.
      context.on("page", (p) => {
        sent ??= framesSent(p);
      });
    });
    const frames = () => sent ?? [];
    const bea = await sitDown(browser, info, guest, guest.gameId);
    const whatIf = ada.locator(".toolbar").getByRole("button", { name: "What if" });
    // Offered once the rules are in: the prediction runs on this device.
    await expect(whatIf).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => frames().some((f) => f.includes('"hello"'))).toBe(true);
    const before = frames().length;

    await whatIf.click();
    await expect(whatIf).toHaveAttribute("aria-pressed", "true");
    await expect(ada.locator(".sketch-stamp")).toBeVisible();
    // Her own move, and a guess at Germany's, both tapped on the map.
    await tap(ada, "PAR");
    await tap(ada, "BUR");
    await tap(ada, "MUN");
    await tap(ada, "BUR");
    await expect(ada.locator("svg.board-live g.order")).toHaveCount(2);
    await expect(ada.locator(".sheet-note")).toContainText("What if: 2 orders sketched");

    await tab(ada, "Orders");
    const predicted = ada.getByRole("group", { name: "Predicted results" });
    await expect(predicted.locator(".receipt.fail")).toHaveCount(2);
    await expect(predicted).toContainText("Standoff in Burgundy");
    await predicted.getByRole("button", { name: "Why? A PAR - BUR" }).click();
    await expect(ada.getByRole("region", { name: "Why A PAR - BUR failed" })).toContainText("A MUN");
    await expect(ada.getByRole("group", { name: "Sketch orders for" }).getByRole("button", { name: "Germany 1 order" })).toHaveAttribute("aria-pressed", "true");
    await scan(ada, "what if in a live room");

    // Not one frame left this device while the sketch was open.
    expect(frames().slice(before)).toEqual([]);
    // Germany's guess stays in the sketch; only her own orders become real, and are filed.
    await ada.getByRole("button", { name: "Use my sketched orders" }).click();
    await expect(ada.locator(".sketch-stamp")).toHaveCount(0);
    await expect(ada.locator(".orders .row.given code")).toHaveText(["A PAR - BUR"]);
    await expect.poll(() => frames().slice(before).filter((f) => f.includes("orders.set")).length).toBeGreaterThan(0);
    expect(frames().slice(before).some((f) => f.includes("A MUN"))).toBe(false);

    // Germany really goes to Burgundy.
    await closeSheet(bea);
    await tap(bea, "MUN");
    await tap(bea, "BUR");
    for (const p of [ada, bea]) {
      await closeSheet(p);
      await primary(p).click();
    }
    for (const p of [ada, bea]) await expect(primary(p)).toHaveText(/^Continue to Fall 1901/, { timeout: 30_000 });
    await tab(ada, "Results");
    const results = ada.getByRole("group", { name: "Adjudication results" });
    await expect(results).toContainText("Standoff in Burgundy");
    await results.getByRole("button", { name: "Why? A PAR - BUR" }).click();
    await expect(ada.getByRole("region", { name: "Why A PAR - BUR failed" })).toContainText("A MUN");
    await scan(ada, "why in a live room");
    for (const p of [ada, bea]) await p.context().close();
  });
});

import { readFile } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";
import { closeSheet, isPhone, openSheet, primary, ready, resolveAndContinue, selectPower, tap } from "./helpers.js";

const orders = (page: Page, power: string) => page.getByLabel(`${power} orders`);
const results = (page: Page) => page.getByLabel("Adjudication results");
const hint = (page: Page) => page.locator(".toolbar .hint");
const tool = (page: Page, name: string) => page.locator(".toolbar").getByRole("button", { name });

/** Two phases in which Italy walks into Trieste with support and knocks the Austrian fleet out. */
async function italyTakesTrieste(page: Page) {
  await tap(page, "VEN");
  await tap(page, "TYR");
  await tap(page, "ROM");
  await tap(page, "VEN");
  await resolveAndContinue(page);
  await tap(page, "VEN");
  await tap(page, "TRI");
  await tap(page, "TYR");
  await tool(page, "Support").click();
  await tap(page, "VEN");
  await tap(page, "TRI");
  await expect(primary(page)).toHaveText("Adjudicate Fall 1901");
  await primary(page).click();
}

test.describe("convoys", () => {
  test("an army crosses the sea on a convoy", async ({ page }) => {
    await ready(page);
    await tap(page, "LON");
    await tap(page, "NTH");
    await tap(page, "LVP");
    await tap(page, "YOR");
    await resolveAndContinue(page);

    // Norway can only be reached by sea, so the click writes the convoyed move.
    await tap(page, "YOR");
    await tap(page, "NWY");
    await tap(page, "NTH");
    await tool(page, "Convoy").click();
    await expect(hint(page)).toContainText("click the army");
    await tap(page, "YOR");
    await tap(page, "NWY");

    await selectPower(page, "England");
    await openSheet(page);
    await expect(orders(page, "England")).toContainText("A YOR - NWY VIA");
    await expect(orders(page, "England")).toContainText("F NTH C A YOR - NWY");
    // Only one route exists, so there is nothing to switch.
    await expect(orders(page, "England").getByRole("button", { name: /go by convoy/ })).toHaveCount(0);
    await closeSheet(page);

    await primary(page).click();
    await openSheet(page);
    await expect(results(page).locator(".receipt.ok", { hasText: "A YOR - NWY VIA" })).toBeVisible();
    await expect(results(page).locator(".receipt.ok", { hasText: "F NTH C A YOR - NWY" })).toBeVisible();
    await closeSheet(page);
    await primary(page).click();
    await openSheet(page);
    await expect(page.locator("table.powers tbody tr", { hasText: "England" }).locator("td").first()).toHaveText("4");
  });

  test("where an army could walk or sail, a switch sends it by convoy", async ({ page }) => {
    await ready(page);
    await tap(page, "LON");
    await tap(page, "ENG");
    await tap(page, "LVP");
    await tap(page, "WAL");
    await resolveAndContinue(page);

    await tap(page, "WAL");
    await tap(page, "LON");
    await selectPower(page, "England");
    await openSheet(page);
    // The click gives the land route...
    await expect(orders(page, "England").locator(".row.given code")).toHaveText(["A WAL - LON"]);
    // ...and the order carries a switch to the convoy and back.
    const via = orders(page, "England").getByRole("button", { name: /go by convoy/ });
    await expect(via).toHaveAttribute("aria-pressed", "false");
    await via.click();
    await expect(orders(page, "England").locator(".row.given code")).toHaveText(["A WAL - LON VIA"]);
    await expect(via).toHaveAttribute("aria-pressed", "true");
    await via.click();
    await expect(orders(page, "England").locator(".row.given code")).toHaveText(["A WAL - LON"]);
    await via.click();
    await closeSheet(page);

    await tap(page, "ENG");
    await tool(page, "Convoy").click();
    await tap(page, "WAL");
    await tap(page, "LON");
    await primary(page).click();
    await openSheet(page);
    await expect(results(page).locator(".receipt.ok", { hasText: "A WAL - LON VIA" })).toBeVisible();
    await expect(results(page).locator(".receipt.ok", { hasText: "F ENG C A WAL - LON" })).toBeVisible();
  });
});

test.describe("convoy routes", () => {
  test("an army is sent by convoy first, then the player picks the fleet that carries it", async ({ page }, info) => {
    await ready(page);
    await tap(page, "LON");
    await tap(page, "ENG");
    await tap(page, "LVP");
    await tap(page, "WAL");
    await resolveAndContinue(page);

    await tap(page, "WAL");
    const byConvoy = tool(page, "By convoy");
    await expect(byConvoy).toHaveAttribute("aria-pressed", "false");
    if (isPhone(info)) await byConvoy.click();
    else await page.keyboard.press("v");
    await expect(byConvoy).toHaveAttribute("aria-pressed", "true");
    await expect(hint(page)).toHaveText("A WAL by convoy: click where the fleets should land it.");
    // Only coasts a fleet can reach are lit: Liverpool, next door by land, is not one of them.
    await expect(page.locator("svg.board path.target")).not.toHaveCount(0);
    await expect(page.getByRole("button", { name: /^By convoy to Liverpool/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^By convoy to London/ })).toBeVisible();

    // London could be reached on foot too; the route chosen first wins.
    await tap(page, "LON");
    const route = page.getByRole("group", { name: /Route/ });
    await expect(route).toContainText("A WAL - LON VIA");
    await expect(route).toContainText("needs a fleet");
    const fleet = route.getByRole("button", { name: "Order F ENG C A WAL - LON" });
    await fleet.click();
    await expect(route).toContainText("carried by");
    await expect(route.getByRole("button", { name: /F ENG carries it/ })).toHaveAttribute("aria-pressed", "true");
    // The army's track is drawn through the fleet, which wears a ring instead of a line of its own.
    await expect(page.locator("svg.board-live g.order.routed")).toHaveCount(1);
    await expect(page.locator("svg.board-live g.order.carrying")).toHaveCount(1);

    await selectPower(page, "England");
    await openSheet(page);
    await expect(orders(page, "England")).toContainText("A WAL - LON VIA");
    await expect(orders(page, "England")).toContainText("F ENG C A WAL - LON");
    await closeSheet(page);
    await primary(page).click();
    await openSheet(page);
    await expect(results(page).locator(".receipt.ok", { hasText: "A WAL - LON VIA" })).toBeVisible();
    await expect(results(page).locator(".receipt.ok", { hasText: "F ENG C A WAL - LON" })).toBeVisible();
  });

  test("By convoy is only offered to an army a fleet could carry, and a second press goes by land", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await expect(tool(page, "Move")).toBeVisible();
    await expect(tool(page, "By convoy")).toHaveCount(0);
    await tool(page, "Cancel").click();

    await tap(page, "LON");
    await tap(page, "ENG");
    await tap(page, "LVP");
    await tap(page, "WAL");
    await resolveAndContinue(page);
    await tap(page, "WAL");
    await tool(page, "By convoy").click();
    await tool(page, "By convoy").click();
    await expect(tool(page, "By convoy")).toHaveAttribute("aria-pressed", "false");
    await tap(page, "LON");
    await selectPower(page, "England");
    await openSheet(page);
    await expect(orders(page, "England").locator(".row.given code")).toHaveText(["A WAL - LON"]);
  });
});

test.describe("retreats and adjustments", () => {
  test("a dislodged unit retreats, then winter builds and disbands are capped at what is owed", async ({ page }) => {
    await ready(page);
    await italyTakesTrieste(page);

    // The button names the phase that comes next, not the one on screen.
    await expect(primary(page)).toHaveText("Continue to Fall 1901 retreats");
    await openSheet(page);
    await expect(results(page)).toContainText("was dislodged by the attack from Venice");
    await expect(results(page)).toContainText("It may retreat to");
    await closeSheet(page);
    await primary(page).click();

    await expect(primary(page)).toHaveText("Resolve Fall 1901 retreats");
    await expect(hint(page)).toContainText("Click a dislodged unit");
    await expect(page.locator("svg.board-live g.unit.dislodged")).toHaveCount(1);
    await tap(page, "TRI");
    await tap(page, "ALB");
    await selectPower(page, "Austria");
    await openSheet(page);
    await expect(orders(page, "Austria")).toContainText("F TRI R ALB");
    await closeSheet(page);
    await primary(page).click();
    await openSheet(page);
    await expect(results(page).locator(".receipt.ok", { hasText: "F TRI R ALB" })).toBeVisible();
    await closeSheet(page);
    await expect(primary(page)).toHaveText("Continue to Winter 1901 builds");
    await primary(page).click();

    // Italy is owed one build.
    await expect(primary(page)).toHaveText("Resolve Winter 1901 builds");
    await selectPower(page, "Italy");
    await tap(page, "ROM");
    await page.getByRole("menuitem", { name: "A ROM B" }).click();
    await tap(page, "VEN");
    await expect(hint(page)).toHaveText("Italy may only build 1 unit. Remove an order to choose a different one.");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await openSheet(page);
    await expect(orders(page, "Italy").locator(".row.given code")).toHaveText(["A ROM B"]);
    await expect(page.getByRole("button", { name: "Waive a build" })).toBeDisabled();
    await closeSheet(page);

    // Austria lost a centre and must remove one unit, and only one.
    await selectPower(page, "Austria");
    await tap(page, "ALB");
    await tap(page, "VIE");
    await expect(hint(page)).toHaveText("Austria only has to disband 1 unit. Remove an order to choose a different one.");
    await openSheet(page);
    await expect(orders(page, "Austria").locator(".row.given code")).toHaveText(["F ALB D"]);
    await closeSheet(page);

    await primary(page).click();
    await openSheet(page);
    await expect(results(page).locator(".receipt.ok", { hasText: "A ROM B" })).toBeVisible();
    await expect(results(page).locator(".receipt.ok", { hasText: "F ALB D" })).toBeVisible();
    // No engine debug text reaches the player.
    await expect(results(page)).not.toContainText(/illegal|AllowanceUsed|NothingToDo/);
    await closeSheet(page);
    await expect(primary(page)).toHaveText("Continue to Spring 1902");
    await primary(page).click();
    await openSheet(page);
    const units = (power: string) => page.locator("table.powers tbody tr", { hasText: power }).locator("td").nth(1);
    await expect(units("Italy")).toHaveText("4");
    await expect(units("Austria")).toHaveText("2");
  });

  test("a dislodged unit can be disbanded instead, and that is not shown as a failure", async ({ page }) => {
    await ready(page);
    await italyTakesTrieste(page);
    await primary(page).click();
    await tap(page, "TRI");
    await tool(page, "Disband").click();
    await selectPower(page, "Austria");
    await openSheet(page);
    await expect(orders(page, "Austria")).toContainText("F TRI D");
    await closeSheet(page);
    await primary(page).click();
    await openSheet(page);
    const receipt = results(page).locator(".receipt", { hasText: "F TRI D" });
    await expect(receipt).toHaveClass(/neutral/);
    await expect(receipt).toContainText("The unit was disbanded.");
    await closeSheet(page);
    await primary(page).click();
    // Austria now has two units for two centres: nothing to adjust.
    await selectPower(page, "Austria");
    await openSheet(page);
    await expect(orders(page, "Austria")).toContainText("Austria has nothing to build or disband.");
  });

  test("a build can be waived, and removing a waive frees it again", async ({ page }) => {
    await ready(page);
    await italyTakesTrieste(page);
    await primary(page).click();
    await tap(page, "TRI");
    await tap(page, "ALB");
    await resolveAndContinue(page);
    await selectPower(page, "Italy");
    await openSheet(page);
    const waive = page.getByRole("button", { name: "Waive a build" });
    await waive.click();
    await expect(orders(page, "Italy").locator(".row.given code")).toHaveText(["WAIVE"]);
    await expect(waive).toBeDisabled();
    await orders(page, "Italy").getByRole("button", { name: "Remove WAIVE" }).click();
    await expect(orders(page, "Italy").locator(".row.given")).toHaveCount(0);
    await expect(waive).toBeEnabled();
  });
});

test.describe("the open power", () => {
  test("a retreat phase opens on the power that has to retreat", async ({ page }) => {
    await ready(page);
    await italyTakesTrieste(page);
    await primary(page).click();
    await expect(primary(page)).toHaveText("Resolve Fall 1901 retreats");
    // Italy gave the last order, but only Austria has anything to do now.
    await expect(page.locator(".choices h2")).toContainText("Austria");
    await expect(page.locator(".choices button")).toHaveText(["F TRI: Fleet Trieste"]);
    await openSheet(page);
    await expect(page.locator("table.powers tr.active")).toContainText("Austria");
    await expect(orders(page, "Austria")).toContainText("F TRI");
    await closeSheet(page);

    // Winter: Austria lost Trieste and owes a disband, so it stays open and has choices.
    await tap(page, "TRI");
    await tap(page, "ALB");
    await resolveAndContinue(page);
    await expect(primary(page)).toHaveText("Resolve Winter 1901 builds");
    await openSheet(page);
    await expect(page.locator("table.powers tr.active")).toContainText("Austria");
    await expect(page.locator("table.powers tr.active td").last()).toHaveText("-1");
    await closeSheet(page);
    await expect(page.locator(".choices button")).not.toHaveCount(0);

    // Spring: France, which was open before Italy's orders, is not forced back; whoever is
    // open still has units, so nothing changes.
    await resolveAndContinue(page);
    await openSheet(page);
    await expect(page.locator("table.powers tr.active")).toContainText("Austria");
  });

  test("the dislodged piece is drawn over the unit that pushed it out", async ({ page }) => {
    await ready(page);
    await italyTakesTrieste(page);
    await primary(page).click();
    await expect(page.locator("svg.board-live g.unit.dislodged")).toHaveCount(1);
    // Later in the document is nearer the eye.
    await expect(page.locator("svg.board-live g.units > g.unit").last()).toHaveClass(/dislodged/);
  });
});

test.describe("receipts in context", () => {
  test("a unit that bounced back is not said to have held its ground, and a tie is called a tie", async ({ page }) => {
    await ready(page);
    await tap(page, "MUN");
    await tap(page, "BUR");
    await resolveAndContinue(page);
    // Paris and Brest bounce in Picardy, so Paris is still at home when Burgundy arrives.
    await tap(page, "PAR");
    await tap(page, "PIC");
    await tap(page, "BRE");
    await tap(page, "PIC");
    await tap(page, "BUR");
    await tap(page, "PAR");
    await primary(page).click();
    await openSheet(page);
    const attack = results(page).locator(".receipt", { hasText: "A BUR - PAR" });
    await expect(attack).toContainText("The unit in Paris failed to move out, and the attack was not strong enough to dislodge it.");
    await expect(attack).not.toContainText("held its ground");
    await expect(results(page).locator(".receipt", { hasText: "A PAR - PIC" })).toContainText(
      "Bounced with the unit from Brest: equal strength, so nobody got in.",
    );
  });

  test("a convoy paradox gets a sentence, not a rule number alone", async ({ page }) => {
    // Pandin's paradox (DATC 6.F.16), set up from a saved position.
    await ready(page);
    await openSheet(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: "pandins-paradox.json",
      mimeType: "application/json",
      buffer: await readFile(new URL("./fixtures/pandins-paradox.json", import.meta.url)),
    });
    await closeSheet(page);
    await expect(page.locator("svg.board-live g.unit")).toHaveCount(6);

    await tap(page, "LON");
    await tool(page, "Support").click();
    await tap(page, "WAL");
    await tap(page, "ENG");
    await tap(page, "WAL");
    await tap(page, "ENG");
    await tap(page, "BRE");
    await tap(page, "LON");
    await tap(page, "ENG");
    await tool(page, "Convoy").click();
    await tap(page, "BRE");
    await tap(page, "LON");
    await tap(page, "NTH");
    await tool(page, "Support").click();
    await tap(page, "BEL");
    await tap(page, "ENG");
    await tap(page, "BEL");
    await tap(page, "ENG");

    await primary(page).click();
    await openSheet(page);
    const convoy = results(page).locator(".receipt", { hasText: "F ENG C A BRE - LON" });
    await expect(convoy).toHaveAttribute("data-code", "paradox");
    await expect(convoy).toHaveClass(/fail/);
    await expect(convoy).toContainText("A convoy paradox: the orders contradict each other, so by the Szykman rule the convoy fails.");
    await expect(results(page).locator(".receipt", { hasText: "A BRE - LON VIA" })).toContainText(
      "No unbroken chain of fleets carried the army across.",
    );
    // Nobody got into the Channel, and the fleet there was not dislodged.
    await expect(results(page).locator(".receipt.fail", { hasText: "F WAL - ENG" })).toBeVisible();
    await expect(results(page).locator(".receipt.fail", { hasText: "F BEL - ENG" })).toBeVisible();
    await expect(results(page)).not.toContainText("was dislodged");
  });
});

test.describe("keyboard", () => {
  test("the left arrow steps into the results from the board, not from a button", async ({ page }, info) => {
    test.skip(isPhone(info), "arrow keys are a keyboard matter");
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await resolveAndContinue(page);
    await expect(primary(page)).toHaveText("Adjudicate Fall 1901");

    for (const name of ["Export", "Russia"]) {
      await page.getByRole("button", { name }).focus();
      await page.keyboard.press("ArrowLeft");
      await expect(primary(page)).toHaveText("Adjudicate Fall 1901");
    }
    await page.locator("#main").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(primary(page)).toHaveText("Continue to Fall 1901");
  });
});

test.describe("repairs", () => {
  test("undo from the results view leaves a board that still takes orders", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await primary(page).click();
    await expect(primary(page)).toHaveText("Continue to Fall 1901");
    await openSheet(page);
    await page.getByRole("button", { name: "Undo last phase" }).click();
    await expect(page.locator(".phase-title")).toContainText("Spring 1901");
    await expect(page.locator(".tag")).toHaveCount(0);
    await closeSheet(page);
    await expect(primary(page)).toHaveText("Adjudicate Spring 1901");

    // The board is live: a unit can be picked and re-ordered straight away.
    await tap(page, "PAR");
    await expect(page.locator("svg.board path.selected")).toHaveCount(1);
    await tap(page, "PIC");
    await openSheet(page);
    await expect(orders(page, "France")).toContainText("A PAR - PIC");
  });

  test("a mouse drag that ends outside the map does not leave it stuck to the cursor", async ({ page }, info) => {
    test.skip(isPhone(info), "mouse behaviour");
    await ready(page);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    const svg = page.locator("svg.board");
    const box = (await svg.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const viewBox = () => svg.getAttribute("viewBox");
    const before = await viewBox();

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 60, cy - 30, { steps: 4 });
    // Carry on past the edge of the map and let go out there.
    await page.mouse.move(box.x + box.width + 120, cy, { steps: 4 });
    await page.mouse.up();
    const released = await viewBox();
    expect(released).not.toBe(before);

    // With no button held, moving over the map must not move the map.
    await page.mouse.move(cx, cy, { steps: 4 });
    await page.mouse.move(cx + 150, cy + 90, { steps: 4 });
    expect(await viewBox()).toBe(released);
  });

  test("a unit keeps its piece on the board from one phase to the next", async ({ page }) => {
    await ready(page);
    const unit = (label: string) => page.locator("svg.board-live g.unit", { has: page.locator("title", { hasText: label }) });
    const id = await unit("France: A MAR").getAttribute("data-unit");
    await unit("France: A MAR").evaluate((el) => {
      (el as unknown as { marked: boolean }).marked = true;
    });
    const ids = await page.locator("svg.board-live g.unit").evaluateAll((els) => els.map((el) => el.getAttribute("data-unit")).sort());
    expect(new Set(ids).size).toBe(22);

    await tap(page, "MAR");
    await tap(page, "SPA");
    await resolveAndContinue(page);

    // Same identity, same DOM node, new province: the piece was moved, not replaced.
    await expect(unit("France: A SPA")).toHaveAttribute("data-unit", id!);
    expect(await unit("France: A SPA").evaluate((el) => (el as unknown as { marked?: boolean }).marked)).toBe(true);
    await expect(unit("France: A MAR")).toHaveCount(0);
    const after = await page.locator("svg.board-live g.unit").evaluateAll((els) => els.map((el) => el.getAttribute("data-unit")).sort());
    expect(after).toEqual(ids);
  });

  test("the selected unit is marked in brass, never in vermilion", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    const stroke = await page.locator("svg.board path.selected").evaluate((el) => getComputedStyle(el).stroke);
    const brassDeep = await page.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--brass-deep)";
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    });
    expect(stroke).toBe(brassDeep);
    await expect(page.locator("svg.board path.target").first()).toBeVisible();
  });
});

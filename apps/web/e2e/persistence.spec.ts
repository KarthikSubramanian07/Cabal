import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { closeSheet, openSheet, primary, ready, resolveAndContinue, selectPower, tap } from "./helpers.js";

test.describe("saving and loading", () => {
  test("a reload brings the game back, orders and all", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await resolveAndContinue(page);
    await tap(page, "BUR");
    await tap(page, "MUN");

    await page.reload();
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
    const notice = page.locator(".resume");
    await expect(notice).toContainText("Saved game restored.");
    await expect(notice).toContainText("Fall 1901 movement");
    await openSheet(page);
    await expect(page.locator(".phase-title")).toContainText("Fall 1901");
    // The order written before the reload is still on the table.
    await expect(page.getByLabel("France orders")).toContainText("A BUR - MUN");
    await expect(page.getByLabel("Phase history")).toBeVisible();
    await closeSheet(page);
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toHaveCount(0);
  });

  test("a reload does not turn the units left alone into written orders", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await primary(page).click();
    await openSheet(page);
    const receipts = page.getByLabel("Adjudication results").locator(".receipt code");
    await expect(receipts).toHaveCount(1);
    await closeSheet(page);
    await expect(page.locator("svg.board-live .order.hold")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
    await openSheet(page);
    await page.getByRole("button", { name: "Previous phase" }).click();
    // One order was written, so one receipt, and no hold rings round the other 21 units.
    await expect(receipts).toHaveCount(1);
    await expect(receipts).toContainText("A PAR - BUR");
    await closeSheet(page);
    await expect(page.locator("svg.board-live .order.hold")).toHaveCount(0);
  });

  test("undo after a reload brings back only what was written", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    // A hold that really was written is an order like any other and must survive.
    await tap(page, "MAR");
    await tap(page, "MAR");
    await resolveAndContinue(page);

    await page.reload();
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
    await openSheet(page);
    await page.getByRole("button", { name: "Undo last phase" }).click();
    await selectPower(page, "France");
    await openSheet(page);
    const given = page.getByLabel("France orders").locator(".row.given code");
    await expect(given).toHaveCount(2);
    await expect(given.filter({ hasText: "A MAR H" })).toHaveCount(1);
    await expect(given.filter({ hasText: "A PAR - BUR" })).toHaveCount(1);
    await expect(page.getByLabel("France orders").locator(".row.missing code")).toHaveText(["F BRE"]);
    for (const power of ["Austria", "England", "Germany", "Italy", "Russia", "Turkey"]) {
      await selectPower(page, power);
      await openSheet(page);
      await expect(page.getByLabel(`${power} orders`).locator(".row.given")).toHaveCount(0);
    }
  });

  test("the open power survives a reload even when no order changed after choosing it", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await selectPower(page, "Russia");
    await page.reload();
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
    await openSheet(page);
    await expect(page.locator("table.powers tr.active")).toContainText("Russia");
  });

  test("a save that names a power that does not exist opens France", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("cabal.sandbox"))).toContain("A PAR - BUR");
    await page.evaluate(() => {
      const save = JSON.parse(localStorage.getItem("cabal.sandbox")!);
      localStorage.setItem("cabal.sandbox", JSON.stringify({ ...save, active: "ATLANTIS" }));
    });
    // Leave before the page can write its own save over the edited one.
    await page.goto("/about");
    await ready(page);
    await expect(page.locator(".resume")).toContainText("Saved game restored.");
    await openSheet(page);
    await expect(page.locator("table.powers tr.active")).toContainText("France");
    await expect(page.locator(".sidebar h2", { hasText: "Atlantis" })).toHaveCount(0);
  });

  test("a save from before the written orders were kept still loads", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await resolveAndContinue(page);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("cabal.sandbox"))).toContain("F1901M");
    await page.evaluate(() => {
      const { written: _written, ...save } = JSON.parse(localStorage.getItem("cabal.sandbox")!);
      localStorage.setItem("cabal.sandbox", JSON.stringify({ ...save, schema: 1 }));
    });
    await page.goto("/about");
    await ready(page);
    await expect(page.locator(".resume")).toContainText("Fall 1901 movement");
    await openSheet(page);
    await page.getByRole("button", { name: "Previous phase" }).click();
    await expect(page.getByLabel("Adjudication results").locator(".receipt code")).toHaveCount(1);
  });

  test("Import asks before it replaces a game in progress", async ({ page }) => {
    // A fresh game, as Export writes it.
    await ready(page);
    await openSheet(page);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export" }).click()]);
    const fresh = await readFile((await download.path())!);
    await closeSheet(page);

    await tap(page, "PAR");
    await tap(page, "BUR");
    await resolveAndContinue(page);
    await resolveAndContinue(page);
    await openSheet(page);
    await expect(page.locator(".phase-title")).toContainText("Spring 1902");
    const saved = await page.evaluate(() => localStorage.getItem("cabal.sandbox"));

    const input = page.locator('input[type="file"]');
    await input.setInputFiles({ name: "fresh.json", mimeType: "application/json", buffer: fresh });
    const dialog = page.getByRole("dialog", { name: "Replace this game?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("fresh.json");
    await expect(dialog).toContainText("2 resolved phases");
    await expect(dialog.getByRole("button", { name: "Keep playing" })).toBeFocused();
    // Nothing has been replaced yet, on the board or on the device.
    expect(await page.evaluate(() => localStorage.getItem("cabal.sandbox"))).toBe(saved);
    await dialog.getByRole("button", { name: "Keep playing" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".phase-title")).toContainText("Spring 1902");
    expect(await page.evaluate(() => localStorage.getItem("cabal.sandbox"))).toBe(saved);

    await input.setInputFiles({ name: "fresh.json", mimeType: "application/json", buffer: fresh });
    await dialog.getByRole("button", { name: "Load the file" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".phase-title")).toContainText("Spring 1901");
    await expect(page.getByLabel("Phase history")).toHaveCount(0);
  });

  test("a bad file never opens the replace question", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await resolveAndContinue(page);
    await openSheet(page);
    await page.locator('input[type="file"]').setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from("{}") });
    await expect(page.locator(".import-error p")).toHaveText("That file is not a Cabal game export. It has no phases in it.");
    await expect(page.getByRole("dialog", { name: "Replace this game?" })).toBeHidden();
    await expect(page.locator(".phase-title")).toContainText("Fall 1901");
  });

  test("New game asks first, in a dialog, and a new game stays new after a reload", async ({ page }) => {
    let nativeDialogs = 0;
    page.on("dialog", (d) => {
      nativeDialogs += 1;
      void d.dismiss();
    });
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await resolveAndContinue(page);

    await openSheet(page);
    await page.getByRole("button", { name: "New game" }).click();
    const dialog = page.getByRole("dialog", { name: "Start a new game?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1 resolved phase");
    // The safe choice has the focus.
    await expect(dialog.getByRole("button", { name: "Keep playing" })).toBeFocused();
    await dialog.getByRole("button", { name: "Keep playing" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".phase-title")).toContainText("Fall 1901");

    await page.getByRole("button", { name: "New game" }).click();
    await dialog.getByRole("button", { name: "Start a new game" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".phase-title")).toContainText("Spring 1901");
    expect(nativeDialogs).toBe(0);

    await page.reload();
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".resume")).toHaveCount(0);
    await openSheet(page);
    await expect(page.locator(".phase-title")).toContainText("Spring 1901");
  });

  test("a save this build cannot read is ignored, not half-loaded", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cabal.sandbox", JSON.stringify({ schema: 999, game: "{}", orders: {}, active: "X", savedAt: 1 }));
    });
    await ready(page);
    await expect(page.locator(".resume")).toHaveCount(0);
    await expect(page.locator("svg.board-live g.unit")).toHaveCount(22);
  });

  test("a corrupt save does not stop the board from loading", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "cabal.sandbox",
        JSON.stringify({
          schema: 2,
          game: '{"phases":[{"name":"S1901M","state":{"nonsense":true},"orders":{}}]}',
          written: [],
          orders: {},
          active: "FRANCE",
          savedAt: 1,
        }),
      );
    });
    await ready(page);
    await expect(page.locator("svg.board-live g.unit")).toHaveCount(22);
    await expect(page.locator(".resume")).toHaveCount(0);
  });

  test("export and import round trip a game", async ({ page }) => {
    await ready(page);
    await tap(page, "PAR");
    await tap(page, "BUR");
    await resolveAndContinue(page);
    await openSheet(page);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export" }).click()]);
    expect(download.suggestedFilename()).toBe("cabal-f1901m.json");
    const exported = await readFile((await download.path())!);

    await page.getByRole("button", { name: "New game" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Start a new game" }).click();
    await expect(page.locator(".phase-title")).toContainText("Spring 1901");

    await page.locator('input[type="file"]').setInputFiles({ name: "game.json", mimeType: "application/json", buffer: exported });
    await expect(page.locator(".phase-title")).toContainText("Fall 1901");
    await expect(page.getByLabel("Phase history")).toBeVisible();
  });

  test("a file that is not a game gets a plain sentence, with the parser's words tucked away", async ({ page }) => {
    await ready(page);
    await openSheet(page);
    const input = page.locator('input[type="file"]');
    const error = page.locator(".import-error");

    await input.setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from("{ this is not json") });
    await expect(error.locator("p")).toHaveText("That file is not a Cabal game export. It is not JSON.");
    await expect(error.locator("details")).not.toHaveAttribute("open", "");
    await expect(error.locator("code")).toBeHidden();
    // Nothing a JSON parser says is shown as the message.
    await expect(error.locator("p")).not.toContainText(/position|line \d|column|Expected|Unexpected/);
    await closeSheet(page);
    await expect(page.locator(".toolbar .hint")).not.toContainText(/JSON|position/);
    await openSheet(page);

    await input.setInputFiles({ name: "other.json", mimeType: "application/json", buffer: Buffer.from('{"hello":"world"}') });
    await expect(error.locator("p")).toHaveText("That file is not a Cabal game export. It has no phases in it.");
    // The board is untouched.
    await expect(page.locator("svg.board-live g.unit")).toHaveCount(22);
    await expect(primary(page)).toHaveText("Adjudicate Spring 1901");
  });
});

test.describe("when the board cannot load", () => {
  test("says so and offers a way back, instead of waiting forever", async ({ page }) => {
    await page.route("**/*.wasm", (route) => route.abort());
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "The board did not load." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Reload the page" })).toBeVisible();
    await expect(page.getByText("Setting up the board.")).toHaveCount(0);

    await page.unroute("**/*.wasm");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("svg.board-live g.unit")).toHaveCount(22);
  });

  test("a failed map download gets the same treatment", async ({ page }) => {
    await page.route("**/assets/board-*.js", (route) => route.abort());
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "The board did not load." })).toBeVisible({ timeout: 20_000 });
  });
});

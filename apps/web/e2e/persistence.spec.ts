import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { closeSheet, openSheet, primary, ready, resolveAndContinue, tap } from "./helpers.js";

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
    await expect(page.locator("svg.board g.unit")).toHaveCount(22);
  });

  test("a corrupt save does not stop the board from loading", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "cabal.sandbox",
        JSON.stringify({ schema: 1, game: '{"phases":[{"name":"S1901M","state":{"nonsense":true},"orders":{}}]}', orders: {}, active: "FRANCE", savedAt: 1 }),
      );
    });
    await ready(page);
    await expect(page.locator("svg.board g.unit")).toHaveCount(22);
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
    await expect(page.locator("svg.board g.unit")).toHaveCount(22);
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
    await expect(page.locator("svg.board g.unit")).toHaveCount(22);
  });

  test("a failed map download gets the same treatment", async ({ page }) => {
    await page.route("**/assets/board-*.js", (route) => route.abort());
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "The board did not load." })).toBeVisible({ timeout: 20_000 });
  });
});

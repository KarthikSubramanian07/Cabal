import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { SECRET, accountRoutes, fakeServer, fixture, signedIn } from "./api.js";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function openMenu(page: import("@playwright/test").Page) {
  await page.locator(".player-button").click();
}

test.describe("the player's account", () => {
  test("nobody is asked for anything until they play", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    await page.goto("/games");
    await expect(page.getByRole("heading", { level: 1, name: "The games room" })).toBeVisible();
    await page.goto("/ledger");
    await expect(page.getByRole("heading", { level: 1, name: "The Ledger" })).toBeVisible();
    expect(server.calls.filter((c) => c.startsWith("POST /api/players"))).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("cabal.player"))).toBeNull();
  });

  test("a taken handle is refused in words, and Pick one for me lets the server choose", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server, { taken: ["ada"] });
    await page.goto("/games");
    await openMenu(page);
    await page.getByRole("button", { name: "Choose a handle" }).click();
    const dialog = page.getByRole("dialog", { name: "Choose your handle" });
    await dialog.getByLabel("Handle").fill("ada");
    await dialog.getByRole("button", { name: "Take this handle" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Someone already has that handle. Try another.");
    await expect(dialog.getByLabel("Handle")).toBeFocused();
    await dialog.getByRole("button", { name: "Pick one for me" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account, quiet_otter");
  });

  test("rename, then the recovery code is shown once, copied and saved as a file", async ({ page, context }, info) => {
    const server = await fakeServer(page);
    accountRoutes(server, { taken: ["taken_name"] });
    await signedIn(page);
    await page.goto("/games");
    await openMenu(page);
    await expect(page.getByText("Playing as ada_l")).toBeVisible();
    await page.getByRole("button", { name: "Rename" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    await expect(card.getByLabel("Handle")).toHaveValue("ada_l");
    await card.getByLabel("Handle").fill("taken_name");
    await card.getByRole("button", { name: "Rename" }).click();
    await expect(card.getByRole("alert")).toHaveText("Someone already has that handle. Try another.");
    await card.getByLabel("Handle").fill("lovelace");
    await card.getByRole("button", { name: "Rename" }).click();
    await expect(card.getByRole("status").filter({ hasText: "You are lovelace now." })).toBeVisible();
    await expect(card.getByLabel("Handle")).toBeDisabled();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account, lovelace");

    await card.getByRole("button", { name: "Make a recovery code" }).click();
    await expect(card.getByLabel("Your recovery code")).toContainText("CABAL-7K2M-QX9P-H4TR-W8NB-3DFG");
    if (info.project.name === "desktop") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await card.getByRole("button", { name: "Copy the code" }).click();
      await expect(card.getByText("Copied.")).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("CABAL-7K2M-QX9P-H4TR-W8NB-3DFG");
    }
    const download = page.waitForEvent("download");
    await card.getByRole("link", { name: "Save it as a file" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("cabal-recovery-lovelace.txt");
    const text = await (await import("node:fs/promises")).readFile((await file.path())!, "utf8");
    expect(text).toContain("CABAL-7K2M-QX9P-H4TR-W8NB-3DFG");
    expect(text).toContain("Handle: lovelace");

    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  });

  test("focus stays on the recovery code just made, though the account is read again", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    await page.goto("/ledger");
    await openMenu(page);
    // Opened at the name: the section the card would otherwise pull focus back to.
    await page.getByRole("button", { name: "Rename" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    await expect(card.getByLabel("Handle")).toBeFocused();
    await card.getByRole("button", { name: "Make a recovery code" }).click();
    await expect(card.getByRole("group", { name: "Your recovery code" })).toBeFocused();
    await expect.poll(() => server.calls.filter((c) => c === "GET /api/me").length).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(500);
    await expect(card.getByRole("group", { name: "Your recovery code" })).toBeFocused();
  });

  test("the account card meets WCAG 2.2 target size on every screen", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    await page.goto("/ledger");
    await openMenu(page);
    await page.getByRole("button", { name: "Rename" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    await expect(card.getByRole("link", { name: "See your public record" })).toBeVisible();
    const box = await card.getByRole("link", { name: "See your public record" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag22aa"]).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });

  test("restore an account on a new device from its recovery code", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    await page.goto("/games");
    await openMenu(page);
    await page.getByRole("button", { name: "Restore an account" }).click();
    const dialog = page.getByRole("dialog", { name: "Restore your account" });
    await dialog.getByLabel("Recovery code").fill("not a code at all, no");
    await dialog.getByRole("button", { name: "Restore my account" }).click();
    await expect(dialog.getByRole("alert")).toContainText("That recovery code is not valid.");
    await dialog.getByLabel("Recovery code").fill("cabal-7k2m qx9p\nh4tr w8nb 3dfg");
    await dialog.getByRole("button", { name: "Restore my account" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account, restored_one");
    expect(server.calls).toContain("POST /api/players/recover");
  });

  test("sign out warns when there is no recovery code, and forgets the secret", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    await page.goto("/games");
    await openMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    await card.getByRole("button", { name: "Sign out of this device" }).click();
    await expect(card.getByText("You have no recovery code.")).toBeVisible();
    await card.getByRole("button", { name: "Sign out of this device" }).click();
    await expect(card).toBeHidden();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account");
    expect(await page.evaluate(() => localStorage.getItem("cabal.player"))).toBeNull();
  });

  test("signing out takes the account's seats off the device, so the next person cannot play as it", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    await page.addInitScript(() => {
      const seat = (gameId: string, extra: Record<string, unknown>) =>
        localStorage.setItem(`cabal.seat.${gameId}`, JSON.stringify({ gameId, power: "ENGLAND", token: `${gameId}.secret-seat-token`, savedAt: 1, ...extra }));
      seat("Z2BSVX", { name: "ada_l", userId: "pl_test_ada" });
      // Taken under the handle before seats recorded their account.
      seat("K7Q2XZ", { name: "ada_l" });
      // Somebody else's, sat down without an account.
      seat("ABCDEF", { name: "Guest" });
    });
    await page.goto("/games");
    await openMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    await expect(card.getByText("Your seats leave this device with you")).toBeVisible();
    await card.getByRole("button", { name: "Sign out of this device" }).click();
    await card.getByRole("group", { name: "Confirm signing out" }).getByRole("button", { name: "Sign out of this device" }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("cabal.player"))).toBeNull();
    const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("cabal.seat.")));
    expect(left).toEqual(["cabal.seat.ABCDEF"]);
    expect(server.calls).toContain("POST /api/me/logout");
  });

  test("deleting the account asks for the handle typed out, then lets go of the device", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    const asked: unknown[] = [];
    server.on("DELETE", /^\/api\/me$/, (request) => {
      asked.push(request.postDataJSON());
      return { body: { deleted: true, games: 2, unreached: 0 } };
    });
    await signedIn(page);
    await page.addInitScript(() => {
      localStorage.setItem("cabal.seat.Z2BSVX", JSON.stringify({ gameId: "Z2BSVX", power: "ENGLAND", token: "Z2BSVX.secret-seat-token", savedAt: 1, name: "ada_l", userId: "pl_test_ada" }));
    });
    await page.goto("/games");
    await openMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    const section = card.getByRole("region", { name: "Delete the account" });
    await section.getByRole("button", { name: "Delete this account" }).click();
    // The safe choice has focus, and the destructive one waits for the handle.
    await expect(section.getByRole("button", { name: "Keep my account" })).toBeFocused();
    const confirm = section.getByRole("button", { name: "Delete for good" });
    await expect(confirm).toBeDisabled();
    await section.getByLabel("Type ada_l to confirm").fill("ada");
    await expect(confirm).toBeDisabled();
    await section.getByRole("button", { name: "Keep my account" }).click();
    await expect(confirm).toHaveCount(0);
    expect(asked).toEqual([]);

    await section.getByRole("button", { name: "Delete this account" }).click();
    await section.getByLabel("Type ada_l to confirm").fill("ADA-L");
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
    await confirm.click();
    await expect(card.getByRole("status")).toContainText("The account is deleted.");
    await expect(card.getByRole("status")).toContainText("seats in 2 games are now a ghost's");
    expect(asked).toEqual([{ handle: "ADA-L" }]);
    await expect(card.getByRole("status")).toContainText("This device is signed out.");
    // The seats and the secret go at once, while the farewell is still on screen: a dead secret
    // must not survive a reload or a closed tab.
    expect(await page.evaluate(() => localStorage.getItem("cabal.seat.Z2BSVX"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("cabal.player"))).toBeNull();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account");
    await card.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(card).toBeHidden();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account");
  });

  test("a deletion some games could not hear of yet says so instead of promising the name is gone", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    server.on("DELETE", /^\/api\/me$/, () => ({ body: { deleted: true, games: 3, unreached: 1 } }));
    await signedIn(page);
    await page.goto("/games");
    await openMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    const section = card.getByRole("region", { name: "Delete the account" });
    await section.getByRole("button", { name: "Delete this account" }).click();
    await section.getByLabel("Type ada_l to confirm").fill("ada_l");
    await section.getByRole("button", { name: "Delete for good" }).click();
    await expect(card.getByRole("status")).toContainText("one game could not be reached just now");
    await expect(card.getByRole("status")).not.toContainText("nothing on Cabal carries the name");
  });

  test("a refused deletion says why and keeps the account", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    server.on("DELETE", /^\/api\/me$/, () => ({ status: 400, body: { error: "type the account's handle to delete it", code: "handle_mismatch" } }));
    await signedIn(page);
    await page.goto("/games");
    await openMenu(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    const section = page.getByRole("dialog", { name: "Your account" }).getByRole("region", { name: "Delete the account" });
    await section.getByRole("button", { name: "Delete this account" }).click();
    await section.getByLabel("Type ada_l to confirm").fill("ada_l");
    await section.getByRole("button", { name: "Delete for good" }).click();
    await expect(section.getByRole("alert")).toContainText("That is not the account's handle.");
    expect(await page.evaluate(() => localStorage.getItem("cabal.player"))).not.toBeNull();
  });

  test("restoring another account warns first when the one on the device has no recovery code", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    await page.addInitScript(() => {
      localStorage.setItem("cabal.seat.Z2BSVX", JSON.stringify({ gameId: "Z2BSVX", power: "ENGLAND", token: "Z2BSVX.secret-seat-token", name: "ada_l", userId: "pl_test_ada", savedAt: 1 }));
    });
    await page.goto("/ledger");
    await openMenu(page);
    await page.getByRole("button", { name: "Restore another account" }).click();
    const dialog = page.getByRole("dialog", { name: "Restore your account" });
    await expect(dialog.getByText("that account has no recovery code")).toBeVisible();
    // A new handle would lose the account just the same: that way is not offered here.
    await expect(dialog.getByRole("button", { name: "Choose a new handle instead" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Keep playing as ada_l" })).toBeVisible();
    await dialog.getByLabel("Recovery code").fill("CABAL-7K2M-QX9P-H4TR-W8NB-3DFG");
    await dialog.getByRole("button", { name: "Restore my account" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Tick the box to leave ada_l behind");
    await expect(dialog.getByLabel("Leave ada_l behind for good")).toBeFocused();
    expect(server.calls).not.toContain("POST /api/players/recover");

    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

    await dialog.getByLabel("Leave ada_l behind for good").check();
    await dialog.getByRole("button", { name: "Restore my account" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account, restored_one");
    // The account left behind is signed out of the device, seats and all.
    expect(server.calls).toContain("POST /api/me/logout");
    expect(await page.evaluate(() => localStorage.getItem("cabal.seat.Z2BSVX"))).toBeNull();
  });

  test("Make a recovery code first leads to the code, and keeps the account", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    await page.goto("/ledger");
    await openMenu(page);
    await page.getByRole("button", { name: "Restore another account" }).click();
    const dialog = page.getByRole("dialog", { name: "Restore your account" });
    await dialog.getByRole("button", { name: "Make a recovery code first" }).click();
    await expect(dialog).toBeHidden();
    const card = page.getByRole("dialog", { name: "Your account" });
    await expect(card.getByRole("button", { name: "Make a recovery code" })).toBeFocused();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cabal.player")!).id)).toBe("pl_test_ada");
  });

  test("Play now with a secret the server no longer knows asks for a handle and plays", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    const secrets: (string | undefined)[] = [];
    server.on("POST", /^\/api\/games$/, (request) => {
      const auth = request.headers()["authorization"];
      secrets.push(auth);
      if (auth === "Bearer ps_dead") return { status: 401, body: { error: "that player secret is not valid; sign in again or play without it", code: "signed_out" } };
      return { status: 201, body: { gameId: "K7Q2XZ", token: "K7Q2XZ.tok", power: "ITALY" } };
    });
    server.on("POST", /^\/api\/games\/K7Q2XZ\/start$/, () => ({ body: { ...fixture<Record<string, unknown>>("summary-Z2BSVX"), id: "K7Q2XZ", status: "active", finished: null } }));
    await page.addInitScript(() => localStorage.setItem("cabal.player", JSON.stringify({ id: "pl_gone", handle: "gone_one", secret: "ps_dead", savedAt: 1 })));
    await page.goto("/");
    await page.getByRole("button", { name: /Play now/ }).click();
    const dialog = page.getByRole("dialog", { name: "Choose your handle" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("This device is no longer signed in to its account.")).toBeVisible();
    await dialog.getByLabel("Handle").fill("fresh_start");
    await dialog.getByRole("button", { name: "Take this handle" }).click();
    await expect(page).toHaveURL(/\/g\/K7Q2XZ$/);
    expect(secrets).toEqual(["Bearer ps_dead", `Bearer ${SECRET}`]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cabal.player")!).handle)).toBe("fresh_start");
  });

  test("a secret the server no longer knows signs the device out instead of acting as nobody", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    server.on("GET", /^\/api\/me$/, () => ({ status: 401, body: { error: "sign in again" } }));
    await signedIn(page);
    await page.goto("/games");
    await openMenu(page);
    await page.getByRole("button", { name: "Recovery code" }).click();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account");
    expect(await page.evaluate(() => localStorage.getItem("cabal.player"))).toBeNull();
  });

  test("a signed-in player sits down under their handle, with no name to type", async ({ page }) => {
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    let body: unknown = null;
    server.on("POST", /^\/api\/games$/, (request) => {
      body = { json: request.postDataJSON(), auth: request.headers()["authorization"] };
      return { status: 201, body: { gameId: "K7Q2XZ", token: "K7Q2XZ.tok", power: "ITALY" } };
    });
    await page.goto("/games");
    await page.getByRole("button", { name: "Set a new table" }).click();
    const dialog = page.getByRole("dialog", { name: "Set a new table" });
    await expect(dialog.getByText("You sit as ada_l")).toBeVisible();
    await dialog.getByRole("button", { name: "Set the table" }).click();
    await expect(page).toHaveURL(/\/g\/K7Q2XZ$/);
    expect((body as { auth: string }).auth).toBe(`Bearer ${SECRET}`);
    expect((body as { json: { name?: string } }).json.name).toBeUndefined();
  });
});

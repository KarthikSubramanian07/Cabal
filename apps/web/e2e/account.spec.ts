import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { SECRET, accountRoutes, fakeServer, signedIn } from "./api.js";

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

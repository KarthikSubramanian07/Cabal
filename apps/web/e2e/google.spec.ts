/**
 * Signing in with Google as the main way in, against a stand-in for Google's button (the real one
 * needs Google's servers): the Sign in button, naming a new account, settings arriving from the
 * player's other device, a menu that says the account follows them, and a one-step Sign out.
 */
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { SECRET, accountRoutes, fakeServer, freshProfile } from "./api.js";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Google Identity Services, reduced to a button that answers with a token at once. */
const FAKE_GSI = `window.google = { accounts: { id: {
  initialize(config) { window.__gsiCount = (window.__gsiCount || 0) + 1; window.__gsi = config; },
  renderButton(el) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Continue with Google";
    b.onclick = () => window.__gsi.callback({ credential: "header.claims-of-a-test-token.signature" });
    el.appendChild(b);
  },
  disableAutoSelect() {},
} } };`;

async function withGoogle(page: Page, outcome: "created" | "signed_in" = "created") {
  const server = await fakeServer(page);
  const state = accountRoutes(server);
  const google = { linked: false, pushes: [] as unknown[] };
  await page.route("https://accounts.google.com/gsi/client", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_GSI }));
  server.on("GET", /^\/api\/auth\/google$/, () => ({ body: { clientId: "1234-test.apps.googleusercontent.com" } }));
  server.on("POST", /^\/api\/auth\/google$/, () => {
    google.linked = true;
    state.handle = outcome === "created" ? "quiet_otter" : "ada_g";
    return { status: outcome === "created" ? 201 : 200, body: { player: { id: "pl_test_g", handle: state.handle, createdAt: Date.UTC(2026, 10, 1) }, secret: SECRET, outcome } };
  });
  server.on("GET", /^\/api\/me$/, (request) =>
    request.headers()["authorization"] === `Bearer ${SECRET}` && !state.signedOut
      ? { body: { ...freshProfile(state.handle), account: { renameAvailableAt: state.renameAvailableAt, recoveryIssuedAt: null, sessions: 2, google: google.linked } } }
      : { status: 401, body: { error: "sign in again" } },
  );
  // The player's other device turned the shortcuts off a moment ago.
  server.on("GET", /^\/api\/me\/sync$/, () => ({ body: { prefs: { shortcuts: false }, prefsAt: Date.now() + 60_000, sandbox: null } }));
  server.on("PATCH", /^\/api\/me\/sync$/, (request) => {
    google.pushes.push(request.postDataJSON());
    return { body: { prefs: null, prefsAt: null, sandbox: null } };
  });
  server.on("GET", /^\/api\/me\/games$/, () => ({ body: { games: [{ gameId: "Z2BSVX", power: "ITALY", status: "playing", joinedAt: 1, finishedAt: null, result: null, score: null, centers: null, ratingDelta: null }] } }));
  return { server, state, google };
}

test.describe("signing in with Google", () => {
  test("Sign in leads with Google; a new account is named, and settings arrive from the other device", async ({ page }) => {
    const { server } = await withGoogle(page);
    await page.goto("/games");
    const signIn = page.locator(".player-button");
    await expect(signIn).toHaveAccessibleName("Sign in");
    await signIn.click();
    const dialog = page.getByRole("dialog", { name: "Sign in to Cabal" });
    await expect(dialog.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Play as a guest" })).toBeVisible();
    expect((await new AxeBuilder({ page }).include("dialog[open]").withTags(TAGS).analyze()).violations).toEqual([]);

    await dialog.getByRole("button", { name: "Continue with Google" }).click();
    const welcome = page.getByRole("dialog", { name: "Welcome to Cabal" });
    await expect(welcome.getByLabel("Handle")).toHaveValue("quiet_otter");
    await welcome.getByLabel("Handle").fill("ada_g");
    await welcome.getByRole("button", { name: "Take this handle" }).click();
    await expect(welcome).toBeHidden();
    await expect(signIn).toHaveAccessibleName("Your account, ada_g");
    expect(server.calls).toContain("PATCH /api/me");

    // The account's newer settings came down to this device.
    await expect.poll(() => page.evaluate(() => localStorage.getItem("cabal.shortcuts"))).toBe("off");
    // And the seat it holds from the other device is listed here.
    await expect(page.getByRole("link", { name: /Z2B SVX.*Italy.*from another device/ })).toBeVisible();
  });

  test("an account that signs in with Google says so, has no recovery chores, and signs out in one step", async ({ page }) => {
    const { server } = await withGoogle(page, "signed_in");
    await page.goto("/games");
    await page.locator(".player-button").click();
    await page.getByRole("dialog", { name: "Sign in to Cabal" }).getByRole("button", { name: "Continue with Google" }).click();
    // An existing account is signed straight in: no naming step.
    await expect(page.locator(".player-button")).toHaveAccessibleName("Your account, ada_g");
    await page.locator(".player-button").click();
    await expect(page.getByText("With Google, on every device")).toBeVisible();
    await expect(page.getByRole("button", { name: "Recovery code" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in with Google to keep it" })).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator(".player-button")).toHaveAccessibleName("Sign in");
    expect(await page.evaluate(() => localStorage.getItem("cabal.player"))).toBeNull();
    expect(server.calls).toContain("POST /api/me/logout");
  });

  test("a guest is offered Google to keep the account, from the menu", async ({ page }) => {
    await withGoogle(page);
    await page.goto("/games");
    await page.locator(".player-button").click();
    await page.getByRole("dialog", { name: "Sign in to Cabal" }).getByRole("button", { name: "Play as a guest" }).click();
    const guest = page.getByRole("dialog", { name: "Play as a guest" });
    await guest.getByRole("button", { name: "Pick one for me" }).click();
    await expect(guest).toBeHidden();
    await page.locator(".player-button").click();
    await expect(page.getByText("Guest account, in this browser only")).toBeVisible();
    await page.getByRole("button", { name: "Sign in with Google to keep it" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    await expect(card.getByRole("heading", { name: "Sign in with Google" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  });

  test("Google is started once however many buttons are drawn", async ({ page }) => {
    await withGoogle(page);
    await page.goto("/games");
    await page.locator(".player-button").click();
    await page.getByRole("dialog", { name: "Sign in to Cabal" }).getByRole("button", { name: "Play as a guest" }).click();
    await page.getByRole("button", { name: "Sign in with Google instead." }).click();
    await expect(page.getByRole("dialog", { name: "Sign in to Cabal" }).getByRole("button", { name: "Continue with Google" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __gsiCount: number }).__gsiCount)).toBe(1);
  });
});

/**
 * The lobby against a real cabal-server (see playwright.live.config.ts). Two browser contexts
 * are two people on two devices: separate storage, separate sockets.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Browser, Page } from "@playwright/test";
import { clientHeaders, expect, test } from "./fixtures.js";
import { chooseHandle, uniqueHandle } from "./room.js";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${state}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(blocking).toEqual([]);
}

/** A second person on their own device, with the same screen size as this project's. */
async function stranger(browser: Browser, page: Page): Promise<Page> {
  const viewport = page.viewportSize()!;
  const context = await browser.newContext({ viewport, serviceWorkers: "block", baseURL: new URL(page.url()).origin, extraHTTPHeaders: clientHeaders() });
  return context.newPage();
}

const codeOf = (page: Page) => new URL(page.url()).pathname.split("/").pop()!;

/** Whatever this device stored about seats: the token must live here and only here. */
const storedSeat = (page: Page, code: string) =>
  page.evaluate((code) => JSON.parse(localStorage.getItem(`cabal.seat.${code}`) ?? "null") as { token: string; power: string } | null, code);

test.describe("the lobby, live", () => {
  test("a host sets a public table, a stranger finds it, picks a seat, they talk, and the game starts", async ({ page, browser }) => {
    test.slow(); // two devices, a whole lobby, four accessibility scans and the board
    // The host sets the table.
    await page.goto("/games");
    await expect(page.getByRole("heading", { level: 1, name: "The games room" })).toBeVisible();
    await page.getByRole("button", { name: "Set a new table" }).click();
    const dialog = page.getByRole("dialog", { name: "Set a new table" });
    await scan(page, "create dialog");
    await dialog.getByRole("radio", { name: /^Live/ }).check();
    await dialog.getByRole("radio", { name: /^Draw size/ }).check();
    await dialog.getByLabel("Rules").selectOption("1982");
    await dialog.getByRole("checkbox", { name: /Include all survivors/ }).uncheck();
    await dialog.getByRole("radio", { name: /^List it in the games room/ }).check();
    await dialog.getByRole("button", { name: "Set the table" }).click();
    const ada = uniqueHandle("ada");
    await chooseHandle(page, ada);

    await expect(page).toHaveURL(/\/g\/[A-Z2-9]{6}$/);
    const code = codeOf(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`${code.slice(0, 3)} ${code.slice(3)}`);
    await expect(page.getByText("Waiting for players. 1 of 7 seated.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "You are the host" })).toBeVisible();
    // The settings the host chose are the table's terms.
    const terms = page.getByRole("region", { name: "Terms of the table" });
    await expect(terms).toContainText("Live, 10 minutes to move");
    await expect(terms).toContainText("1982 rules");
    await expect(terms).toContainText("May name who shares");
    await expect(terms).toContainText("Draw size");
    // The seat token is on this device, never in the address.
    const hostSeat = await storedSeat(page, code);
    expect(hostSeat?.token).toMatch(new RegExp(`^${code}\\.`));
    expect(page.url()).not.toContain(hostSeat!.token);
    await scan(page, "lobby, host");

    // A stranger finds it in the games room.
    const guest = await stranger(browser, page);
    await guest.goto("/games");
    const row = guest.getByRole("row", { name: new RegExp(`${code.slice(0, 3)} ${code.slice(3)}`) });
    await expect(row).toContainText(ada);
    await expect(row).toContainText("1 of 7 seated, 6 open");
    await row.getByRole("link", { name: /Sit down/ }).click();
    await expect(guest).toHaveURL(new RegExp(`/g/${code}$`));

    // Picks a seat from the seating plan and sits down.
    const seats = guest.getByRole("list", { name: "Seats" });
    const power = (await seats.getByRole("button", { name: /Choose this seat/ }).first().locator(".place-power").innerText()).trim();
    // Its name changes once chosen ("Your choice"), so it is found again by its power.
    const choice = seats.getByRole("button", { name: new RegExp(`^${power}`, "i") });
    await choice.click();
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await scan(guest, "lobby, picking a seat");
    await guest.getByRole("button", { name: new RegExp(`^Sit as ${power}$`, "i") }).click();
    const bea = uniqueHandle("bea");
    await chooseHandle(guest, bea);
    await expect(guest.getByText(new RegExp(`You sit as ${power}`, "i"))).toBeVisible();
    expect((await storedSeat(guest, code))?.power).toBe(power.toUpperCase());

    // The host sees the new player without reloading.
    await expect(page.getByText("Waiting for players. 2 of 7 seated.")).toBeVisible();
    await expect(page.getByRole("list", { name: "Seats" })).toContainText(bea);

    // They talk at the table.
    await guest.getByLabel("Message the table").fill("Evening. I come in peace, mostly.");
    await guest.getByLabel("Message the table").press("Enter");
    const hostLog = page.getByRole("log", { name: "Table talk" });
    await expect(hostLog).toContainText("I come in peace, mostly.");
    await expect(hostLog).toContainText(bea);
    await page.getByLabel("Message the table").fill("Welcome, Bea.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(guest.getByRole("log", { name: "Table talk" })).toContainText("Welcome, Bea.");
    await expect(page.getByLabel("Message the table")).toHaveValue("");
    await expect(page.getByLabel("Message the table")).toBeFocused();

    // The host starts; the bot takes the five empty seats; the table becomes the game room for both.
    await page.getByRole("button", { name: "Start the game" }).click();
    for (const p of [page, guest]) {
      await expect(p.getByRole("heading", { level: 1 })).toContainText("Spring 1901, movement", { timeout: 30_000 });
      await expect(p.locator("svg.board")).toBeVisible({ timeout: 30_000 });
      await expect(p.getByRole("list", { name: "Seats this phase" }).getByText(/played by the bot/)).toHaveCount(5);
    }
    // Lobby talk stays readable once the game runs, and the players can still write: the game's
    // own status frame must not be taken for the connection dropping.
    for (const p of [page, guest]) {
      const bar = p.locator(".sheet-bar");
      if ((await bar.isVisible()) && (await bar.getAttribute("aria-expanded")) === "false") await bar.click();
      await p.getByRole("tab", { name: /^Press/ }).click();
      await p.getByRole("button", { name: /^The table/ }).click();
    }
    const guestTable = guest.getByRole("log", { name: /The table/ });
    await expect(guestTable).toContainText("I come in peace, mostly.");
    await expect(guestTable).toContainText("Before the game");
    await expect(guest.locator(".wire-down")).toHaveCount(0);
    await guest.getByLabel("Message the table").fill("Good luck, everyone.");
    await guest.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: /The table/ })).toContainText("Good luck, everyone.");
    await scan(guest, "game in play");

    // It now shows in the games room as a game in play, not an open table.
    await guest.goto("/games");
    const inPlay = guest.getByRole("region", { name: "In play" });
    await expect(inPlay.getByRole("row", { name: new RegExp(`${code.slice(0, 3)} ${code.slice(3)}`) })).toBeVisible();
    await expect(guest.getByRole("region", { name: "Your seats" })).toContainText(new RegExp(power, "i"));
    await guest.context().close();
  });

  test("a code typed by hand finds an unlisted table, and a seat survives a reload", async ({ page, request }) => {
    const created = await (
      await request.post("/api/games", { data: { name: "Cleo", settings: { visibility: "unlisted", aiFill: false } } })
    ).json();
    const code = created.gameId as string;

    // Unlisted: not in the open tables.
    await page.goto("/games");
    await expect(page.getByRole("heading", { level: 2, name: "Open tables" })).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(`${code.slice(0, 3)} ${code.slice(3)}`) })).toHaveCount(0);

    // A bad code is explained, then the real one is typed the lazy way.
    const input = page.getByLabel("Have a code or a link?");
    await input.fill("not a code");
    await page.getByRole("button", { name: "Go to table" }).click();
    await expect(page.getByRole("alert")).toContainText("That is not a table code.");
    await input.fill(`${code.slice(0, 3).toLowerCase()} ${code.slice(3).toLowerCase()}`);
    await page.getByRole("button", { name: "Go to table" }).click();
    await expect(page).toHaveURL(new RegExp(`/g/${code}$`));

    // A spectator reads but cannot write.
    await expect(page.getByText("Take a seat to talk to the table.")).toBeVisible();
    await expect(page.getByLabel("Message the table")).toHaveCount(0);

    // Taking any seat; the first sit-down asks for a handle, and the server can pick one.
    await page.getByRole("button", { name: "Take any open seat" }).click();
    const handleDialog = page.getByRole("dialog", { name: "Choose your handle" });
    await handleDialog.getByRole("button", { name: "Pick one for me" }).click();
    await expect(handleDialog).toBeHidden();
    await expect(page.getByText(/You sit as \w+/)).toBeVisible();
    const seat = await storedSeat(page, code);
    expect(seat?.token).toBeTruthy();

    // The table waits for all seven players, so the host could not start yet; this is not the host.
    await expect(page.getByRole("heading", { name: "You are the host" })).toHaveCount(0);

    // A reload keeps the seat; the address never carried it.
    await page.reload();
    await expect(page.getByText(/You sit as \w+/)).toBeVisible();
    await expect(page.getByLabel("Message the table")).toBeVisible();
    expect(page.url()).toBe(new URL(`/g/${code}`, page.url()).href);
  });

  test("the invite folds out as a QR code that names the table, and folds away again", async ({ page, request }) => {
    const created = await (await request.post("/api/games", { data: { name: "Dora", settings: { visibility: "unlisted", aiFill: true } } })).json();
    const code = created.gameId as string;
    await page.goto(`/g/${code}`);
    const toggle = page.getByRole("button", { name: "QR code" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    const qr = page.getByRole("img", { name: `QR code that opens table ${code.slice(0, 3)} ${code.slice(3)}` });
    await expect(qr).toBeVisible();
    // Big enough to scan from arm's length, square, and every module on the grid.
    const box = (await qr.boundingBox())!;
    expect(Math.round(box.width)).toBe(Math.round(box.height));
    expect(box.width).toBeGreaterThanOrEqual(140);
    await scan(page, "lobby with the QR code");
    await page.getByRole("button", { name: "Hide the QR code" }).click();
    await expect(qr).toBeHidden();
  });

  test("a QR code that cannot load leaves the lobby standing, and can be tried again", async ({ page, request }) => {
    const created = await (await request.post("/api/games", { data: { name: "Dora", settings: { visibility: "unlisted", aiFill: true } } })).json();
    const code = created.gameId as string;
    // The card's code is out of reach: a flaky connection, or a redeploy that took the file away.
    const chunk = /\/assets\/InviteQr-[\w-]+\.js$/;
    await page.route(chunk, (route) => route.abort());
    await page.goto(`/g/${code}`);
    await page.getByRole("button", { name: "QR code" }).click();
    await expect(page.getByRole("status").filter({ hasText: "The QR code would not load." })).toBeVisible();
    // The rest of the lobby is still here, the link a tap away.
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(page.getByText("Something on this page broke.")).toHaveCount(0);
    await scan(page, "lobby with the QR code failed");
    // Back on the network, the card can be fetched again.
    await page.unroute(chunk);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("img", { name: `QR code that opens table ${code.slice(0, 3)} ${code.slice(3)}` })).toBeVisible();
  });

  test("a code nobody dealt is a clear miss", async ({ page }) => {
    await page.goto("/g/ZZZZZZ");
    // The first call to a room that does not exist wakes a Durable Object to say so: allow it time.
    await expect(page.getByRole("heading", { level: 1, name: "No table goes by that code." })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "Find a table" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "The games room" })).toBeVisible();
    await scan(page, "games room");
  });
});

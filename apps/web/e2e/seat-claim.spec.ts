/**
 * A signed-in player opening a table where their account holds a seat from another device: the
 * device asks for its own seat token once, and a socket the server turns away never starts a loop
 * of new tokens (each one would push another device's token out of the seat's eight).
 */
import { expect, test } from "@playwright/test";
import { accountRoutes, fakeServer, fixture, signedIn } from "./api.js";

async function tableWithOurSeat(page: import("@playwright/test").Page) {
  const server = await fakeServer(page);
  accountRoutes(server);
  const summary = fixture<Record<string, unknown> & { seats: Record<string, unknown>[] }>("summary-Z2BSVX");
  const seats = summary.seats.map((s) => (s["power"] === "ENGLAND" ? { ...s, kind: "human", name: "ada_l", handle: "ada_l" } : s));
  server.on("GET", /^\/api\/games\/Z2BSVX$/, () => ({ body: { ...summary, seats } }));
  server.on("GET", /^\/api\/games\/Z2BSVX\/replay$/, () => ({ body: fixture("replay-Z2BSVX") }));
  server.on("GET", /^\/api\/games\/Z2BSVX\/ledger$/, () => ({ body: fixture("ledger-Z2BSVX") }));
  const counts = { minted: 0, sockets: 0 };
  server.on("POST", /^\/api\/games\/Z2BSVX\/seat$/, () => {
    counts.minted++;
    return { body: { gameId: "Z2BSVX", power: "ENGLAND", token: `Z2BSVX.tok${counts.minted}` } };
  });
  return counts;
}

test.describe("claiming a seat held on another device", () => {
  test("a seat open in too many places is kept, said so, and never re-minted in a loop", async ({ page }) => {
    const counts = await tableWithOurSeat(page);
    // The seat already has its eight sockets open elsewhere: every hello is refused with 4429.
    await page.routeWebSocket(/\/api\/games\/Z2BSVX\/ws/, (ws) => {
      counts.sockets++;
      ws.onMessage((message) => {
        const frame = JSON.parse(String(message)) as { t?: string };
        if (frame.t === "hello") void ws.close({ code: 4429, reason: "too many sockets" });
      });
    });
    await signedIn(page);
    await page.goto("/g/Z2BSVX");
    await expect(page.getByText("This seat is open in too many tabs and devices at once.", { exact: false })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2500);
    expect(counts.minted, `seat tokens minted (sockets opened: ${counts.sockets})`).toBe(1);
    expect(counts.sockets).toBeLessThanOrEqual(3);
    // The seat is still this device's.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cabal.seat.Z2BSVX") ?? "null")?.token)).toBe("Z2BSVX.tok1");

    // Reconnect dials once more with the same token; it does not mint another.
    const before = counts.sockets;
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect.poll(() => counts.sockets).toBe(before + 1);
    await page.waitForTimeout(1000);
    expect(counts.minted).toBe(1);
  });

  test("a token the server says is invalid is dropped, and not claimed again in a loop", async ({ page }) => {
    const counts = await tableWithOurSeat(page);
    await page.routeWebSocket(/\/api\/games\/Z2BSVX\/ws/, (ws) => {
      counts.sockets++;
      ws.onMessage((message) => {
        const frame = JSON.parse(String(message)) as { t?: string };
        if (frame.t === "hello") void ws.close({ code: 4401, reason: "bad token" });
      });
    });
    await signedIn(page);
    await page.goto("/g/Z2BSVX");
    // (This stand-in never welcomes the spectator socket that follows, so the page stays loading.)
    await expect.poll(() => counts.minted).toBe(1);
    await page.waitForTimeout(3000);
    expect(counts.minted).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("cabal.seat.Z2BSVX"))).toBeNull();
  });
});

/** A page that breaks gives the player a way back and tells the server what broke, anonymously. */
import { expect, test } from "@playwright/test";
import { fakeServer } from "./api.js";

test("a chunk that fails to load shows the way back and sends one anonymous report", async ({ page }) => {
  const server = await fakeServer(page);
  const reports: unknown[] = [];
  server.on("POST", /^\/api\/errors$/, (request) => {
    reports.push(JSON.parse(request.postData() ?? "null"));
    return { status: 204 };
  });
  // The Ledger's code never arrives, as on a flaky connection just after a deploy.
  await page.route(/\/assets\/LedgerPage-[^/]*\.js$/, (route) => route.abort());
  await page.goto("/ledger");
  await expect(page.getByRole("heading", { level: 1, name: "Something on this page broke." })).toBeVisible();
  // (This suite blocks service workers, so their registration also fails and reports itself.)
  const chunk = () => reports.find((r) => (r as { kind?: string }).kind === "chunk");
  await expect.poll(chunk).toBeTruthy();
  expect(chunk()).toMatchObject({ kind: "chunk", route: "ledger", message: expect.stringContaining("/assets/LedgerPage-") });
  // Neither the page's address nor the site's origin is ever sent, only the route's name and paths.
  expect(JSON.stringify(reports)).not.toContain("localhost");
  expect(JSON.stringify(reports)).not.toContain("/ledger\"");
});

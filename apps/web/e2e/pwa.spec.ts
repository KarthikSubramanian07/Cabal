import { readFile, writeFile } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

/** Load a page and wait until the service worker is installed and in charge of it. */
async function controlled(page: Page, path: string) {
  await page.goto(path);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((done) => navigator.serviceWorker.addEventListener("controllerchange", () => done(), { once: true }));
    }
  });
}

test.describe("the installable app", () => {
  test("links a manifest whose icons are all served", async ({ page, request }) => {
    await page.goto("/games");
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    const manifest = await (await request.get(href!)).json();
    expect(manifest).toMatchObject({ id: "/", scope: "/", start_url: "/", display: "standalone" });
    const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose);
    expect(purposes).toContain("maskable");
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of manifest.icons) expect((await request.get(icon.src)).status(), icon.src).toBe(200);
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveCount(0);
  });

  test("ships a new worker with every build and keeps nothing from older ones", async ({ page, request }) => {
    const sw = await (await request.get("/sw.js")).text();
    const version = /version:"([0-9a-f]{16})"/.exec(sw)?.[1];
    expect(version).toBeTruthy();
    expect(sw).not.toContain("cabal-shell-v1");
    await controlled(page, "/");
    const names = await page.evaluate(() => caches.keys());
    expect(names).toEqual([`cabal-${version}`]);
    // The precache holds the shell and hashed files, never an API answer.
    const urls = await page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname), names[0]!);
    expect(urls).toContain("/index.html");
    expect(urls.some((u) => u.startsWith("/assets/") && u.endsWith(".wasm"))).toBe(true);
    expect(urls.some((u) => u.startsWith("/api"))).toBe(false);
  });

  test("offline, the app routes open from the installed shell and nothing else pretends to work", async ({ page, context }) => {
    await controlled(page, "/games");
    await context.setOffline(true);
    await page.goto("/g/K7Q2XZ");
    // The shell came from the cache; the lobby then says plainly that the server is out of reach.
    await expect(page.getByRole("heading", { level: 1, name: "The game server is not answering." })).toBeVisible();
    await page.goto("/sandbox");
    await expect(page.locator("svg.board")).toBeVisible({ timeout: 20_000 });

    // An API call fails as a network error: no HTML with a 200.
    const api = await page.evaluate(async () => {
      try {
        const res = await fetch("/api/games/ZZZZZZ");
        return `${res.status} ${res.headers.get("content-type")}`;
      } catch {
        return "network error";
      }
    });
    expect(api).toBe("network error");
    // A trust page that was never stored is not faked with the app shell.
    await expect(page.goto("/about")).rejects.toThrow();
    await context.setOffline(false);
  });

  test("a deploy is offered as a reload, never swapped in unasked", async ({ page }, info) => {
    // This rewrites the built sw.js that every spec is served, so it runs in one project only.
    test.skip(info.project.name !== "desktop", "rewrites the shared build; desktop only");
    await controlled(page, "/games");
    await expect(page.getByText("A new version of Cabal is ready.")).toHaveCount(0);
    // The next deploy: the same worker with different bytes, as any change to the build makes it.
    // The browser fetches the worker script itself, out of reach of page.route, so the file changes.
    const file = new URL("../dist/sw.js", import.meta.url);
    const original = await readFile(file, "utf8");
    try {
      await writeFile(file, `${original}\n// next deploy\n`);
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        await registration?.update();
      });
    } finally {
      await writeFile(file, original);
    }
    const slip = page.getByRole("status").filter({ hasText: "A new version of Cabal is ready." });
    await expect(slip).toBeVisible({ timeout: 15_000 });
    // Still the old worker in charge until the player says so.
    const before = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    expect(before).toContain("/sw.js");
    const reloaded = page.waitForEvent("framenavigated");
    await slip.getByRole("button", { name: "Reload" }).click();
    await reloaded;
    await expect(page.getByRole("heading", { level: 1, name: "The games room" })).toBeVisible();
    await expect(page.getByText("A new version of Cabal is ready.")).toHaveCount(0);
  });
});

/**
 * The phase 1 "landing page to a game in progress" metric (docs/PLAN.md section 8, issue #57),
 * against the real server: the clock starts at the front page, a newcomer presses Play now and
 * chooses a handle, and it stops when the first movement phase accepts orders. The target is under
 * 60 seconds; the measured figure is attached to the report. The same visit's anonymous beacon
 * (net/timings.ts) carries that figure and the first order's round trip to the server.
 *
 * METRICS_RECORD=<where> also writes the figure into tools/metrics/metrics.json (one line per
 * screen), e.g. `METRICS_RECORD=production LIVE_ORIGIN=https://playcabal.pages.dev`.
 */
import { expect, test } from "@playwright/test";
// @ts-expect-error: a plain ES module with no type declarations
import { line, record } from "../../../tools/metrics/lib/report.mjs";
import { chooseHandle, primary, tab, uniqueHandle } from "./room.js";

const TARGET_MS = 60_000;

test.describe("phase 1 metrics, live", () => {
  test("the front page to a game in progress in under a minute, and the browser's beacon", async ({ page }, info) => {
    // Keep a copy of what each beacon carries (the network log does not show a beacon's body).
    await page.addInitScript(() => {
      const w = window as unknown as { __beacons: Promise<string>[] };
      w.__beacons = [];
      const send = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => {
        if (data instanceof Blob) w.__beacons.push(data.text());
        return send(url, data);
      };
    });
    const started = Date.now();
    await page.goto("/");
    await page.getByRole("button", { name: /Play now/ }).click();
    await chooseHandle(page, uniqueHandle("tock"));
    await expect(page).toHaveURL(/\/g\/[A-Z2-9]{6}$/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Spring 1901, movement", { timeout: 30_000 });
    await tab(page, "Orders");
    await expect(page.getByRole("button", { name: "Hold the rest" })).toBeEnabled();
    const ms = Date.now() - started;
    info.annotations.push({ type: "landing_to_game_ms", description: String(ms) });
    console.log(`landing_to_game ${info.project.name}: ${ms} ms`);
    // Recorded before it is judged, so a miss is on the record as a fail.
    const where = process.env.METRICS_RECORD;
    if (where) record(line({ id: "landing_to_game", value: `${(ms / 1000).toFixed(1)} s`, pass: ms < TARGET_MS, where: `${where}, ${info.project.name}` }));
    expect(ms).toBeLessThan(TARGET_MS);

    // An order filed is timed from orders.set to orders.ack.
    await page.getByRole("button", { name: "Hold the rest" }).click();
    await expect(page.locator(".sync-line")).toHaveText("Your orders are on file with the server.");
    await expect(primary(page)).toBeEnabled();

    // Leaving the page sends what was measured, as one anonymous beacon the server accepts.
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/metrics");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    const sent = await page.evaluate(() => Promise.all((window as unknown as { __beacons: Promise<string>[] }).__beacons));
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!) as { samples: { metric: string; ms: number }[] };
    expect(body.samples.map((s) => s.metric).sort()).toEqual(expect.arrayContaining(["landing_to_game", "order_rtt"]));
    const landing = body.samples.find((s) => s.metric === "landing_to_game")!;
    expect(landing.ms).toBeGreaterThan(0);
    expect(landing.ms).toBeLessThan(TARGET_MS);
    // Nothing in it names the player, the device or the game.
    expect(JSON.stringify(body)).not.toMatch(/tock_|cps_|\/g\//);
    expect((await answered).status()).toBe(204);
  });
});

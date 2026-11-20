/**
 * How long a table at `/g/:code` takes to load on a slow phone, for one build or two side by side.
 *
 *   node scripts/table-load.mjs <origin> [<other origin>] [--rounds 7]
 *
 * Each origin is a running `vite preview` of a build, proxying `/api` to a game server
 * (playwright.live.config.ts starts the pair; `CABAL_SERVER=http://localhost:8787 pnpm exec vite
 * preview` does by hand). The script makes one started table against the bot on the first origin
 * and loads it, seated, in an iPhone 15 page with Lighthouse's mobile throttling applied through
 * the DevTools protocol: 562.5 ms latency, 1.47 Mbps down, 675 kbps up, 4x CPU, cache off, the
 * service worker blocked. With two origins the loads alternate, so whatever else the machine is
 * doing slows both builds alike. It prints, per origin, the median of:
 *
 *   LCP    the last largest-contentful-paint entry before the page is touched
 *   board  the province codes visible: the map drawn
 *   units  the first piece on the board: the position drawn
 */
import { chromium, devices } from "@playwright/test";

const args = process.argv.slice(2);
let rounds = 7;
const origins = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--rounds") rounds = Number(args[++i]);
  else origins.push(args[i]);
}
if (origins.length === 0 || origins.length > 2) {
  console.error("usage: node scripts/table-load.mjs <origin> [<other origin>] [--rounds 7]");
  process.exit(2);
}

const first = origins[0];
const made = await (
  await fetch(`${first}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", settings: { pacing: "live", aiFill: true, visibility: "unlisted" } }),
  })
).json();
const started = await fetch(`${first}/api/games/${made.gameId}/start`, { method: "POST", headers: { authorization: `Bearer ${made.token}` } });
if (!started.ok) throw new Error(`could not start the table: ${started.status}`);
const seat = { gameId: made.gameId, power: made.power, token: made.token, name: "Ada", savedAt: Date.now() };

const browser = await chromium.launch();
const { defaultBrowserType: _browser, ...phone } = devices["iPhone 15"];

async function load(origin) {
  const context = await browser.newContext({ ...phone, serviceWorkers: "block" });
  await context.addInitScript((s) => localStorage.setItem(`cabal.seat.${s.gameId}`, JSON.stringify(s)), seat);
  await context.addInitScript(() => {
    window.__lcp = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lcp.push(Math.round(e.startTime));
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 562.5, downloadThroughput: (1474.56 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(`${origin}/g/${made.gameId}`, { waitUntil: "commit" });
  await page.locator("svg.board text.label").first().waitFor({ state: "visible", timeout: 60_000 });
  const board = await page.evaluate(() => Math.round(performance.now()));
  await page.locator("svg.board-live g.unit").first().waitFor({ state: "attached", timeout: 60_000 });
  const units = await page.evaluate(() => Math.round(performance.now()));
  await page.waitForTimeout(1000);
  const lcp = (await page.evaluate(() => window.__lcp)).at(-1);
  await context.close();
  return { lcp, board, units };
}

const results = new Map(origins.map((o) => [o, []]));
for (let i = 0; i < rounds; i++) {
  for (const origin of i % 2 ? [...origins].reverse() : origins) results.get(origin).push(await load(origin));
}
await browser.close();

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const [origin, runs] of results) {
  const line = (key) => `${key} ${median(runs.map((r) => r[key]))} ms [${runs.map((r) => r[key]).join(" ")}]`;
  console.log(`${origin}: ${line("lcp")}; ${line("board")}; ${line("units")}`);
}
console.log(`table ${made.gameId}, ${rounds} rounds`);

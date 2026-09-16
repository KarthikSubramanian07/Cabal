// Generates public/og.png, public/apple-touch-icon.png, public/icon-512.png and the README
// screenshots from a running build: pnpm build && pnpm preview, then node scripts/assets.mjs
import { chromium, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://localhost:4173";
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const docs = here("../../../docs/images/");
const favicon = readFileSync(here("../public/favicon.svg"), "utf8");
const wordmark = readFileSync(here("../../../docs/brand/wordmark.svg"), "utf8");

const browser = await chromium.launch();

// icons
for (const [size, file] of [
  [180, "apple-touch-icon.png"],
  [512, "icon-512.png"],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${favicon.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: here(`../public/${file}`), omitBackground: true });
  await page.close();
}

// board crop for the social card
const app = await browser.newPage({ viewport: { width: 1600, height: 1500 }, deviceScaleFactor: 1 });
await app.goto(base, { waitUntil: "networkidle" });
await app.waitForSelector("svg.board");
const board = await app.locator(".board-frame").screenshot({ type: "png" });

const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await og.setContent(`
  <body style="margin:0;width:1200px;height:630px;display:grid;grid-template-columns:520px 1fr;background:#f4f0e6;font-family:system-ui">
    <div style="background:#121110;color:#f4f0e6;padding:64px 56px;display:flex;flex-direction:column;justify-content:space-between;border-right:6px solid #d94f30">
      <div style="width:380px">${wordmark.replace('fill="#121110"', 'fill="#f4f0e6"')}</div>
      <div>
        <div style="font-size:40px;font-weight:700;line-height:1.1;letter-spacing:-0.01em">Diplomacy<br>with receipts.</div>
        <div style="margin-top:18px;font-size:20px;opacity:.75;line-height:1.35">The classic 1901 board in your browser. Every order resolved, every result explained.</div>
      </div>
      <div style="font:500 16px ui-monospace,monospace;color:#c8a24a">playcabal.pages.dev</div>
    </div>
    <div style="overflow:hidden;display:flex;align-items:center;justify-content:center;padding:24px">
      <img src="data:image/png;base64,${board.toString("base64")}" style="height:582px;border:1px solid #121110">
    </div>
  </body>`);
await og.screenshot({ path: here("../public/og.png") });

// README screenshots: a turn with orders, its receipts, and a phone
const shots = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
await shots.goto(base, { waitUntil: "networkidle" });
await shots.waitForSelector("svg.board");
const tap = async (code) => {
  const box = await shots.locator("svg.board text.label", { hasText: new RegExp(`^${code}$`) }).first().boundingBox();
  await shots.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
for (const [a, b] of [["PAR", "BUR"], ["MAR", "SPA"], ["BRE", "MAO"], ["MUN", "BUR"], ["KIE", "DEN"], ["LON", "NTH"], ["EDI", "NWG"], ["SEV", "BLA"], ["ANK", "BLA"], ["VIE", "GAL"], ["WAR", "GAL"], ["VEN", "TYR"], ["CON", "BUL"]]) {
  await tap(a);
  await tap(b);
}
await tap("BUD");
await shots.keyboard.press("s");
await tap("VIE");
await tap("GAL");
await shots.getByRole("button", { name: /^Austria/ }).click();
await shots.screenshot({ path: `${docs}board-orders.png` });
await shots.getByRole("button", { name: "Adjudicate Spring 1901" }).click();
await shots.waitForTimeout(300);
await shots.screenshot({ path: `${docs}board-receipts.png` });

const phone = await browser.newContext({ ...devices["iPhone 15"] });
const p = await phone.newPage();
await p.goto(base, { waitUntil: "networkidle" });
await p.waitForSelector("svg.board");
await p.screenshot({ path: `${docs}board-phone.png` });

await browser.close();
console.log("assets written");

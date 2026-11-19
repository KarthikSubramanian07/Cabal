// Generates public/og.png (the social card; `--og` writes only it and the icons), the app icons (apple-touch-icon.png, icon-192.png, icon-512.png and
// the full-bleed icon-maskable-512.png) and the README screenshots from a running build:
// pnpm build && pnpm preview, then node scripts/assets.mjs. `--icons` writes only the icons.
import { chromium, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:4173";
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const docs = here("../../../docs/images/");
const favicon = readFileSync(here("../public/favicon.svg"), "utf8");
const wordmark = readFileSync(here("../../../docs/brand/wordmark.svg"), "utf8");

const browser = await chromium.launch();

// icons
for (const [size, file] of [
  [180, "apple-touch-icon.png"],
  [192, "icon-192.png"],
  [512, "icon-512.png"],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${favicon.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: here(`../public/${file}`), omitBackground: true });
  await page.close();
}

// The maskable icon: launchers crop it to a circle or a squircle, so the ink fills the whole
// square and the turned A sits inside the central safe zone (a circle of 80 percent).
{
  const maskable = favicon
    .replace(/ rx="\d+"/, "")
    .replace("scale(0.78)", "scale(0.56)")
    .replace("<svg ", '<svg width="512" height="512" ');
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await page.setContent(`<body style="margin:0">${maskable}</body>`);
  await page.screenshot({ path: here("../public/icon-maskable-512.png") });
  await page.close();
}

if (process.argv.includes("--icons")) {
  await browser.close();
  console.log("icons written");
  process.exit(0);
}

// The social card: the front door's war room at night, drawn from the same pieces (the Channel
// cut from the board, the dispatch, its wax seal and the BROKEN stamp, the seven powers' seals),
// in the brand's own fonts. 1200 by 630, what OpenGraph and Twitter cards ask for.
{
  const font = (path) => readFileSync(here(`../node_modules/${path}`)).toString("base64");
  const display = font("@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff2");
  const ui = font("@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2");
  const mono = font("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2");
  const channel = readFileSync(here("../public/art/channel.svg")).toString("base64");
  const wax = "M12 1l2.6 1.9 3.2-.3 1.3 3 3 1.3-.3 3.2L23.7 12l-1.9 2.6.3 3.2-3 1.3-1.3 3-3.2-.3L12 23.7l-2.6-1.9-3.2.3-1.3-3-3-1.3.3-3.2L.3 12l1.9-2.6-.3-3.2 3-1.3 1.3-3 3.2.3z";
  const seal = (color, letter, broken, size) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="${wax}" fill="${color}"/><circle cx="12" cy="12" r="7.2" fill="none" stroke="rgba(18,17,16,.28)" stroke-width=".9"/><text x="12" y="15.6" text-anchor="middle" font-family="D" font-size="9.5" fill="rgba(255,255,255,.92)">${letter}</text>${broken ? '<path d="M13.5 1.6l-2 5 2.6 3.2-3.4 4.4 2 3.6-1.6 5.8" fill="none" stroke="#121110" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' : ""}</svg>`;
  const powers = [["#cf4a3e", "A"], ["#2f5ea8", "E"], ["#4ea3d0", "F"], ["#5b5853", "G"], ["#3f8f4b", "I"], ["#8b62b1", "R"], ["#d9a82c", "T"]];
  const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await og.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: D; src: url(data:font/woff2;base64,${display}) format("woff2"); }
    @font-face { font-family: U; src: url(data:font/woff2;base64,${ui}) format("woff2"); font-weight: 100 900; }
    @font-face { font-family: M; src: url(data:font/woff2;base64,${mono}) format("woff2"); }
    body { margin: 0; width: 1200px; height: 630px; background: #121110; color: #f4f0e6; font-family: U; overflow: hidden; }
    .rule { position: absolute; inset: 0 0 auto; height: 8px; background: #d94f30; }
    .left { position: absolute; left: 64px; top: 70px; width: 560px; }
    .mark { width: 200px; }
    h1 { margin: 40px 0 0; font: 400 72px/0.92 D; text-transform: uppercase; letter-spacing: -0.01em; }
    p.lede { margin: 24px 0 0; font-size: 22px; line-height: 1.4; color: #d9d3c4; width: 540px; }
    .url { position: absolute; left: 64px; bottom: 44px; font: 500 20px M; color: #c8a24a; }
    .map { position: absolute; right: 56px; top: 64px; width: 470px; height: 445px; border: 1px solid #3a3632; background: #171615 url(data:image/svg+xml;base64,${channel}) center / cover; }
    .order { position: absolute; inset: 0; width: 100%; height: 100%; }
    .slip { position: absolute; right: 14px; top: 14px; width: 272px; padding: 14px 16px 14px; background: #fbf9f4; color: #121110; transform: rotate(-2deg); box-shadow: 0 18px 38px rgba(0,0,0,.5); }
    .head { display: flex; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid #d3cab5; color: #5f5a53; font-size: 14px; font-weight: 650; }
    .body { padding: 9px 0 10px; font-size: 16px; line-height: 1.4; }
    .receipt { display: flex; gap: .4em; align-items: center; min-height: 40px; margin-top: 8px; padding-top: 4px; border-top: 1px dashed #d3cab5; font-size: 15px; }
    .seal { display: flex; align-items: center; gap: 10px; font-size: 15px; }
    code { font: 500 15px M; }
    .stamp { position: absolute; right: 12px; bottom: 12px; padding: 3px 9px 2px; border: 3px solid #d94f30; color: #d94f30; font: 400 21px D; text-transform: uppercase; letter-spacing: .04em; transform: rotate(-11deg); }
    .seals { position: absolute; right: 56px; bottom: 40px; width: 472px; display: flex; justify-content: space-between; }
  </style></head><body>
    <div class="rule"></div>
    <div class="left">
      <div class="mark">${wordmark.replace('fill="#121110"', 'fill="#f4f0e6"').replace("<svg ", '<svg width="200" ')}</div>
      <h1>Shake hands.<br>Seal it.<br>Break it.</h1>
      <p class="lede">Diplomacy in your browser. Seven powers, promises sealed in wax, and a Ledger of who kept their word.</p>
    </div>
    <div class="url">playcabal.pages.dev</div>
    <div class="map">
      <svg class="order" viewBox="150 395 380 360" preserveAspectRatio="xMidYMid slice">
        <path d="M295.6 567.1 Q 262 603 226.5 616.5" fill="none" stroke="#d94f30" stroke-width="3.2" stroke-linecap="round"/>
        <path d="M222 618.6l8.6-7.5-0.8 10.9z" fill="#d94f30"/>
        <g transform="translate(295.6 567.1)"><rect x="-9" y="-6" width="18" height="12" fill="#2f5ea8" stroke="#f4f0e6" stroke-width="1.2"/><text y="3.6" text-anchor="middle" font-family="D" font-size="9" fill="#f4f0e6">F</text></g>
      </svg>
      <div class="slip">
        <div class="head"><span>England to France</span><span>Spring 1901</span></div>
        <div class="body">&ldquo;The Channel stays empty. You have my word.&rdquo;</div>
        <div class="seal">${seal("#2f5ea8", "E", true, 34)}<span>Sealed with <code>F LON H</code></span></div>
        <div class="receipt">Ordered <code>F LON - ENG</code></div>
        <div class="stamp">Broken</div>
      </div>
    </div>
    <div class="seals">${powers.map(([c, l], i) => seal(c, l, i === 1, 46)).join("")}</div>
  </body></html>`);
  await og.evaluate(() => document.fonts.ready);
  await og.screenshot({ path: here("../public/og.png") });
  await og.close();
}

if (process.argv.includes("--og")) {
  await browser.close();
  console.log("icons and social card written");
  process.exit(0);
}

// README screenshots: a turn with orders, its receipts, and a phone
const shots = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
await shots.goto(`${base}/sandbox`, { waitUntil: "networkidle" });
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
await p.goto(`${base}/sandbox`, { waitUntil: "networkidle" });
await p.waitForSelector("svg.board");
await p.screenshot({ path: `${docs}board-phone.png` });

await browser.close();
console.log("assets written");

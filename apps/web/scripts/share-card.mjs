// Draws the per-game share card's base image: `public/share/board.png`, a 1200 by 630 indexed PNG
// of the board and a ledger of supply centres, and `src/agent/share-card.json`, which palette
// entry belongs to which supply centre and which tally notch. The Pages worker recolours that
// palette for one game (src/agent/share-card.ts); the pixels never change after this script.
//
//   node scripts/share-card.mjs      (needs Playwright's Chromium, as scripts/assets.mjs does)
//
// The card is drawn twice in Chromium. Once as it looks, with every supply centre in the colour of
// open land and every notch empty. Once as a key, with everything black except each supply centre
// and each notch in a colour of its own, edges not smoothed. A pixel belongs to a centre or a notch
// when the key says so and the look shows plain land or an empty notch there; everything else (the
// sea, borders, centre dots, text) is fixed, and is reduced to the palette entries left over.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { encodeIndexed } from "../src/agent/png.ts";
import { composeBoard } from "../src/map/variant.ts";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// The standard map's provinces on the board's geometry, as the game draws them.
const board = composeBoard(
  JSON.parse(readFileSync(here("../../../crates/cabal-engine/data/maps/standard.json"), "utf8")),
  JSON.parse(readFileSync(here("../src/map/board.json"), "utf8")),
);
const wordmark = readFileSync(here("../../../docs/brand/wordmark.svg"), "utf8");
const font = (path) => readFileSync(here(`../node_modules/${path}`)).toString("base64");

const W = 1200;
const H = 630;
export const CENTRES = "ANK BEL BER BRE BUD BUL CON DEN EDI GRE HOL KIE LON LVP MAR MOS MUN NAP NWY PAR POR ROM RUM SER SEV SMY SPA STP SWE TRI TUN VEN VIE WAR".split(" ");
const POWERS = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"];
const NOTCHES = 18;
const LAND = "#efe6cf";
const NOTCH = "#2b2825";
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// One key colour per dynamic region: centres first, then each power's notches in order.
const regions = [...CENTRES.map((c) => ({ kind: "centre", id: c })), ...POWERS.flatMap((p) => Array.from({ length: NOTCHES }, (_, n) => ({ kind: "notch", id: p, n })))];
const keyOf = (i) => [i + 1, 200, 77];
const css = ([r, g, b]) => `rgb(${r},${g},${b})`;

function page(mode) {
  const key = mode === "key";
  const display = font("@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff2");
  const ui = font("@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2");
  const mono = font("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2");
  const centreKey = new Map(CENTRES.map((c, i) => [c, css(keyOf(i))]));
  const provinces = Object.entries(board.provinces)
    .map(([id, p]) => {
      const centre = centreKey.get(id);
      if (key) return centre ? `<path d="${p.d}" fill="${centre}" shape-rendering="crispEdges"/>` : "";
      const fill = p.kind === "sea" ? "#b9d0da" : p.kind === "impassable" ? "#d5ccb6" : LAND;
      const stroke = p.kind === "sea" ? "none" : "#7a7064";
      return `<path d="${p.d}" fill="${fill}" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round"/>`;
    })
    .join("");
  const dots = key
    ? ""
    : CENTRES.map((c) => {
        const [x, y] = board.provinces[c].label;
        return `<circle cx="${x}" cy="${y}" r="7" fill="#121110" stroke="${LAND}" stroke-width="2.5"/>`;
      }).join("");
  const map = `<svg class="map" viewBox="0 0 ${board.width} ${board.height}" width="540" height="${Math.round((540 * board.height) / board.width)}">
    ${key ? "" : `<rect width="${board.width}" height="${board.height}" fill="#b9d0da"/>`}
    ${key ? "" : (board.lakes ?? []).map((d) => `<path d="${d}" fill="#b9d0da"/>`).join("")}
    ${provinces}
    ${key ? "" : `<path d="${board.seaLines}" fill="none" stroke="#587a8a" stroke-width="1.2" stroke-dasharray="4 5" opacity=".55"/>`}
    ${dots}
  </svg>`;
  const rows = POWERS.map((p, r) => {
    const cells = Array.from({ length: NOTCHES }, (_, n) => {
      const i = CENTRES.length + r * NOTCHES + n;
      return `<i style="background:${key ? css(keyOf(i)) : NOTCH}"></i>`;
    }).join("");
    return `<div class="row"><b>${p.slice(0, 3)}</b><span class="cells">${cells}</span></div>`;
  }).join("");
  return `<!doctype html><html><head><style>
    @font-face { font-family: D; src: url(data:font/woff2;base64,${display}) format("woff2"); }
    @font-face { font-family: U; src: url(data:font/woff2;base64,${ui}) format("woff2"); font-weight: 100 900; }
    @font-face { font-family: M; src: url(data:font/woff2;base64,${mono}) format("woff2"); }
    * { box-sizing: border-box; }
    body { margin: 0; width: ${W}px; height: ${H}px; background: #121110; color: #f4f0e6; font-family: U; overflow: hidden; position: relative; }
    .hide { visibility: ${key ? "hidden" : "visible"}; }
    .rule { position: absolute; inset: 0 0 auto; height: 8px; background: #d94f30; }
    .mark { position: absolute; left: 64px; top: 64px; width: 170px; }
    .eyebrow { position: absolute; left: 64px; top: 140px; font: 500 17px M; letter-spacing: .14em; text-transform: uppercase; color: #c8a24a; }
    h1 { position: absolute; left: 62px; top: 168px; margin: 0; font: 400 38px/1.02 D; text-transform: uppercase; letter-spacing: -0.01em; }
    .ledger { position: absolute; left: 64px; top: 272px; }
    .row { display: flex; align-items: center; height: 24px; margin-bottom: 10px; }
    .row b { width: 58px; font: 500 16px M; letter-spacing: .08em; color: #d9d3c4; }
    .cells { display: flex; gap: 4px; }
    .cells i { display: block; width: 19px; height: 24px; }
    .foot { position: absolute; left: 64px; bottom: 44px; font: 500 19px M; color: #c8a24a; }
    .note { position: absolute; left: 64px; bottom: 76px; font-size: 17px; color: #bdb5a4; }
    .frame { position: absolute; right: 52px; top: 52px; border: 1px solid #3a3632; padding: 0; line-height: 0; background: ${key ? "#000" : "#b9d0da"}; }
    ${key ? "body { background: #000; } .rule, .mark, .eyebrow, h1, .row b, .foot, .note { visibility: hidden; } .frame { border-color: #000; }" : ""}
  </style></head><body>
    <div class="rule"></div>
    <div class="mark">${wordmark.replace('fill="#121110"', 'fill="#f4f0e6"').replace("<svg ", '<svg width="170" ')}</div>
    <div class="eyebrow">Supply centres held</div>
    <h1>The board<br>as it stands</h1>
    <div class="ledger">${rows}</div>
    <div class="note">Eighteen centres win the game outright.</div>
    <div class="foot">playcabal.pages.dev</div>
    <div class="frame">${map}</div>
  </body></html>`;
}

/** RGB pixels of an 8-bit RGB or RGBA PNG, as Chromium writes its screenshots. */
function decode(png) {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("only 8-bit, non-interlaced screenshots");
      channels = { 2: 3, 6: 4 }[data[9]];
      if (!channels) throw new Error(`colour type ${data[9]} is not handled`);
    }
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 3);
  const prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      row[x] = (line[x] + pred) & 255;
    }
    for (let x = 0; x < width; x++) out.set(row.subarray(x * channels, x * channels + 3), (y * width + x) * 3);
    prev.set(row);
  }
  return { width, height, rgb: out };
}

/** Median cut: at most `n` colours standing for `colours` (weighted by how often each appears). */
function medianCut(counts, n) {
  let boxes = [[...counts.entries()].map(([k, w]) => ({ c: [k >> 16, (k >> 8) & 255, k & 255], w }))];
  while (boxes.length < n) {
    let best = -1;
    let bestRange = 0;
    let bestAxis = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let axis = 0; axis < 3; axis++) {
        let lo = 255;
        let hi = 0;
        for (const e of box) [lo, hi] = [Math.min(lo, e.c[axis]), Math.max(hi, e.c[axis])];
        const range = (hi - lo) * Math.log2(1 + box.reduce((s, e) => s + e.w, 0));
        if (range > bestRange) [best, bestRange, bestAxis] = [i, range, axis];
      }
    });
    if (best < 0) break;
    const box = boxes[best].sort((p, q) => p.c[bestAxis] - q.c[bestAxis]);
    const total = box.reduce((s, e) => s + e.w, 0);
    let acc = 0;
    let cut = 1;
    for (; cut < box.length - 1; cut++) {
      acc += box[cut - 1].w;
      if (acc >= total / 2) break;
    }
    boxes = [...boxes.slice(0, best), box.slice(0, cut), box.slice(cut), ...boxes.slice(best + 1)];
  }
  return boxes.map((box) => {
    const w = box.reduce((s, e) => s + e.w, 0);
    return [0, 1, 2].map((a) => Math.round(box.reduce((s, e) => s + e.c[a] * e.w, 0) / w));
  });
}

const browser = await chromium.launch();
const shoot = async (mode) => {
  const tab = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await tab.setContent(page(mode));
  await tab.evaluate(() => document.fonts.ready);
  const shot = await tab.screenshot({ type: "png" });
  await tab.close();
  return decode(shot);
};
const look = await shoot("look");
const key = await shoot("key");
await browser.close();

const land = hex(LAND);
const notch = hex(NOTCH);
const same = (rgb, i, c) => rgb[i] === c[0] && rgb[i + 1] === c[1] && rgb[i + 2] === c[2];
const regionAt = new Int16Array(W * H).fill(-1);
const counts = new Map();
for (let p = 0; p < W * H; p++) {
  const i = p * 3;
  const [r, g, b] = [key.rgb[i], key.rgb[i + 1], key.rgb[i + 2]];
  const k = r - 1;
  if (g === 200 && b === 77 && k >= 0 && k < regions.length && same(look.rgb, i, regions[k].kind === "centre" ? land : notch)) {
    regionAt[p] = k;
  } else {
    const c = (look.rgb[i] << 16) | (look.rgb[i + 1] << 8) | look.rgb[i + 2];
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
}
const seen = new Set(regionAt);
const missing = regions.filter((_, k) => !seen.has(k));
if (missing.length) throw new Error(`regions with no pixels: ${missing.map((m) => m.id + (m.n ?? "")).join(", ")}`);

const STATIC = 256 - regions.length;
const fixed = counts.size <= STATIC ? [...counts.keys()].map((k) => [k >> 16, (k >> 8) & 255, k & 255]) : medianCut(counts, STATIC);
const nearest = new Map();
const near = (c) => {
  let hit = nearest.get(c);
  if (hit === undefined) {
    const [r, g, b] = [c >> 16, (c >> 8) & 255, c & 255];
    let best = Infinity;
    fixed.forEach(([fr, fg, fb], j) => {
      const d = (fr - r) ** 2 + (fg - g) ** 2 + (fb - b) ** 2;
      if (d < best) [best, hit] = [d, j];
    });
    nearest.set(c, hit);
  }
  return hit;
};
const indices = new Uint8Array(W * H);
for (let p = 0; p < W * H; p++) {
  const i = p * 3;
  indices[p] = regionAt[p] >= 0 ? fixed.length + regionAt[p] : near((look.rgb[i] << 16) | (look.rgb[i + 1] << 8) | look.rgb[i + 2]);
}
// The image as it ships is the neutral board: every centre open land, every notch empty.
const palette = [...fixed, ...regions.map((r) => (r.kind === "centre" ? land : notch))];
const png = await encodeIndexed(W, H, indices, palette);
mkdirSync(here("../public/share"), { recursive: true });
writeFileSync(here("../public/share/board.png"), png);
const layout = {
  $comment: "Written by scripts/share-card.mjs with public/share/board.png. Palette entries of that image: one per supply centre, then each power's tally notches in order.",
  width: W,
  height: H,
  paletteSize: palette.length,
  land,
  notch,
  centres: Object.fromEntries(CENTRES.map((c, i) => [c, fixed.length + i])),
  notches: Object.fromEntries(POWERS.map((p, r) => [p, Array.from({ length: NOTCHES }, (_, n) => fixed.length + CENTRES.length + r * NOTCHES + n)])),
};
writeFileSync(here("../src/agent/share-card.json"), `${JSON.stringify(layout, null, 2)}\n`);
console.log(`share card: ${png.length} bytes, ${fixed.length} fixed colours (from ${counts.size}), ${regions.length} recolourable regions`);

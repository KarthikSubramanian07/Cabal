#!/usr/bin/env node
/**
 * Draws the front door's map: the English Channel and the coasts around it, cut from the game's
 * own board (src/map/board.json, from Natural Earth, with the standard variant's provinces) and coloured for the ink war-room hero.
 * Writes public/art/channel.svg. Run it again if the board changes:
 *
 *   node scripts/landing-map.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { composeBoard } from "../src/map/variant.ts";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// The standard map's provinces on the board's geometry, as the game draws them.
const board = composeBoard(
  JSON.parse(readFileSync(here("../../../crates/cabal-engine/data/maps/standard.json"), "utf8")),
  JSON.parse(readFileSync(here("../src/map/board.json"), "utf8")),
);

/** The crop, in board units: Brittany to Kiel, Clyde to Burgundy. */
export const VIEW = { x: 150, y: 395, w: 380, h: 360 };

const ENGLAND = new Set(["LON", "WAL", "YOR", "LVP", "EDI", "CLY"]);
const FRANCE = new Set(["BRE", "PIC", "PAR", "GAS", "BUR"]);
const GERMANY = new Set(["KIE", "RUH", "BER", "MUN"]);

const pad = 25;
const inView = ([x, y]) => x > VIEW.x - pad && x < VIEW.x + VIEW.w + pad && y > VIEW.y - pad && y < VIEW.y + VIEW.h + pad;

const shapes = [];
for (const [code, p] of Object.entries(board.provinces)) {
  if (!p.label || !inView(p.label)) continue;
  const cls = p.kind === "sea" ? "s" : ENGLAND.has(code) ? "e" : FRANCE.has(code) ? "f" : GERMANY.has(code) ? "g" : "l";
  shapes.push({ code, cls, d: p.d, sea: p.kind === "sea" });
}
// Seas first, so the land's edges sit on top of them.
shapes.sort((a, b) => Number(b.sea) - Number(a.sea));

const centres = Object.entries(board.provinces)
  .filter(([, p]) => p.sc && inView(p.sc))
  .map(([, p]) => `<rect class="c" x="${(p.sc[0] - 3).toFixed(1)}" y="${(p.sc[1] - 3).toFixed(1)}" width="6" height="6" transform="rotate(45 ${p.sc[0]} ${p.sc[1]})"/>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}" width="${VIEW.w * 2}" height="${VIEW.h * 2}">
<style>.s{fill:#171615}.l{fill:#2a2724}.e{fill:#26324a}.f{fill:#25404d}.g{fill:#2c2b29}path{stroke:#4a453f;stroke-width:.7;stroke-linejoin:round}.s{stroke:#2a2724}.c{fill:#c8a24a;opacity:.55}</style>
<rect x="${VIEW.x}" y="${VIEW.y}" width="${VIEW.w}" height="${VIEW.h}" fill="#171615"/>
${shapes.map((s) => `<path class="${s.cls}" d="${s.d}"/>`).join("\n")}
${centres.join("")}
</svg>
`;

writeFileSync(here("../public/art/channel.svg"), svg);
console.log(`landing-map: ${shapes.length} provinces, ${(svg.length / 1024).toFixed(1)} KiB`);

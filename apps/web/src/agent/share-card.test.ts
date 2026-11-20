import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import layout from "./share-card.json";
import { readChunks, readPalette } from "./png.js";
import { OWNED_MIX, POWERS, POWER_COLOURS, centresOf, paletteFor, shareCard } from "./share-card.js";

const base = new Uint8Array(readFileSync(new URL("../../public/share/board.png", import.meta.url)));
const OPENING = {
  AUSTRIA: ["BUD", "TRI", "VIE"],
  ENGLAND: ["EDI", "LON", "LVP"],
  FRANCE: ["BRE", "MAR", "PAR"],
  GERMANY: ["BER", "KIE", "MUN"],
  ITALY: ["NAP", "ROM", "VEN"],
  RUSSIA: ["MOS", "SEV", "STP", "WAR"],
  TURKEY: ["ANK", "CON", "SMY"],
};

describe("the share card", () => {
  it("ships a 1200 by 630 indexed image whose palette the layout describes", () => {
    const [header] = readChunks(base);
    const view = new DataView(header!.data.buffer, header!.data.byteOffset);
    expect([view.getUint32(0), view.getUint32(4)]).toEqual([1200, 630]);
    expect(header!.data[9]).toBe(3);
    expect(readPalette(base)).toHaveLength(layout.paletteSize);
    expect(Object.keys(layout.centres)).toHaveLength(34);
    // As shipped, every centre is open land and every notch empty.
    for (const i of Object.values(layout.centres)) expect(readPalette(base)[i]).toEqual(layout.land);
    for (const p of POWERS) for (const i of layout.notches[p]) expect(readPalette(base)[i]).toEqual(layout.notch);
  });

  it("every recolourable entry is drawn, and none is used for anything else", () => {
    const idat = readChunks(base).filter((c) => c.type === "IDAT");
    const raw = inflateSync(Buffer.concat(idat.map((c) => c.data)));
    const used = new Set<number>();
    for (let y = 0; y < 630; y++) for (let x = 0; x < 1200; x++) used.add(raw[y * 1201 + 1 + x]!);
    const dynamic = [...Object.values(layout.centres), ...POWERS.flatMap((p) => layout.notches[p])];
    for (const i of dynamic) expect(used.has(i), `entry ${i}`).toBe(true);
    expect(new Set(dynamic).size).toBe(dynamic.length);
  });

  it("colours each held centre for its owner and fills one notch per centre", () => {
    const palette = paletteFor(readPalette(base), { ...OPENING, RUSSIA: [...OPENING.RUSSIA, "RUM", "SWE"] });
    const owned = (i: number) => palette[i];
    const [r, g, b] = POWER_COLOURS.RUSSIA;
    const land = layout.land;
    expect(owned(layout.centres.STP)).toEqual([0, 1, 2].map((k) => Math.round([r, g, b][k]! * OWNED_MIX + land[k]! * (1 - OWNED_MIX))));
    expect(owned(layout.centres.BEL)).toEqual(land);
    expect(layout.notches.RUSSIA.map((i) => palette[i])).toEqual([...Array(6).fill(POWER_COLOURS.RUSSIA), ...Array(12).fill(layout.notch)]);
    expect(layout.notches.ENGLAND.slice(0, 4).map((i) => palette[i])).toEqual([...Array(3).fill(POWER_COLOURS.ENGLAND), layout.notch]);
    // Nothing that is not a centre or a notch moves.
    const fixed = readPalette(base);
    const dynamic = new Set([...Object.values(layout.centres), ...POWERS.flatMap((p) => layout.notches[p])]);
    palette.forEach((c, i) => {
      if (!dynamic.has(i)) expect(c).toEqual(fixed[i]);
    });
  });

  it("keeps a solo's tally to the eighteen notches, and ignores names that are not centres", () => {
    const many = ["ANK", "BEL", "BER", "BRE", "BUD", "BUL", "CON", "DEN", "EDI", "GRE", "HOL", "KIE", "LON", "LVP", "MAR", "MOS", "MUN", "NAP", "NWY", "PAR"];
    const palette = paletteFor(readPalette(base), { FRANCE: [...many, "XYZ", "NTH"] });
    expect(layout.notches.FRANCE.every((i) => palette[i]!.join() === POWER_COLOURS.FRANCE.join())).toBe(true);
  });

  it("changes only the palette of the image", () => {
    const card = shareCard(base, OPENING);
    expect(card.length).toBe(base.length);
    const idat = (png: Uint8Array) => readChunks(png).find((c) => c.type === "IDAT")!.data;
    expect(idat(card)).toEqual(idat(base));
    expect(readPalette(card)).not.toEqual(readPalette(base));
  });

  it("reads who holds what from the last phase of a saved game, coasts folded", () => {
    const saved = { phases: [{ name: "S1901M", state: { centers: { FRANCE: ["PAR"] } } }, { name: "F1901M", state: { centers: { FRANCE: ["PAR", "SPA/SC"], ITALY: [7] } } }] };
    expect(centresOf(saved)).toEqual({ FRANCE: ["PAR", "SPA"], ITALY: [] });
    expect(centresOf({ phases: [] })).toBeNull();
    expect(centresOf({ error: "no such game" })).toBeNull();
    expect(centresOf(null)).toBeNull();
  });
});

/**
 * The share card for one table (`/share/g/:code.png`, issue #12): the board with each supply
 * centre in its owner's colour, beside a tally of centres per power, as a link preview shows it.
 *
 * `public/share/board.png` is drawn once at build time (scripts/share-card.mjs) as an indexed PNG
 * whose palette has one entry per supply centre and per tally notch. Here only that palette is
 * rewritten: owned centres take their power's colour mixed into the land as the board draws them,
 * each power's first N notches fill for its N centres. The pixels are copied as they are, so a card
 * costs a few hundred bytes of work and no image library.
 */
import layout from "./share-card.json";
import { type Rgb, readPalette, withPalette } from "./png.js";

export const POWERS = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"] as const;
export type Power = (typeof POWERS)[number];

/** The powers' colours (`--p-*` in styles/tokens.css). */
export const POWER_COLOURS: Readonly<Record<Power, Rgb>> = {
  AUSTRIA: [0xcf, 0x4a, 0x3e],
  ENGLAND: [0x2f, 0x5e, 0xa8],
  FRANCE: [0x4e, 0xa3, 0xd0],
  GERMANY: [0x5b, 0x58, 0x53],
  ITALY: [0x3f, 0x8f, 0x4b],
  RUSSIA: [0x8b, 0x62, 0xb1],
  TURKEY: [0xd9, 0xa8, 0x2c],
};

/** How much of the owner's colour an owned centre shows over the land: stronger than the board's 34 percent, read at thumbnail size. */
export const OWNED_MIX = 0.62;

export type Centres = Partial<Record<string, readonly string[]>>;

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i]! * t + b[i]! * (1 - t))) as unknown as Rgb;
}

const land = layout.land as unknown as Rgb;

/** The card's palette for this holding of centres: `base` is the neutral image's own palette. */
export function paletteFor(base: readonly Rgb[], centres: Centres): Rgb[] {
  const out = [...base];
  for (const power of POWERS) {
    const held = (centres[power] ?? []).filter((c) => c in layout.centres);
    for (const c of held) out[(layout.centres as Record<string, number>)[c]!] = mix(POWER_COLOURS[power], land, OWNED_MIX);
    layout.notches[power].forEach((index, n) => {
      if (n < held.length) out[index] = POWER_COLOURS[power];
    });
  }
  return out;
}

/** The share card for this holding of centres, from the neutral base image's bytes. */
export function shareCard(base: Uint8Array, centres: Centres): Uint8Array {
  return withPalette(base, paletteFor(readPalette(base), centres));
}

/**
 * Who holds which centres now, from the server's answer for a table (`GET /api/games/:id/centres`,
 * `{ centers }`) or from a saved game (`GET /api/games/:id/replay`, the last phase's state). Null
 * when the answer is neither.
 */
export function centresOf(answer: unknown): Centres | null {
  const direct = (answer as { centers?: unknown } | null)?.centers;
  const phases = (answer as { phases?: unknown } | null)?.phases;
  const centers =
    direct !== undefined
      ? direct
      : Array.isArray(phases) && phases.length > 0
        ? (phases.at(-1) as { state?: { centers?: unknown } } | undefined)?.state?.centers
        : undefined;
  if (!centers || typeof centers !== "object" || Array.isArray(centers)) return null;
  const out: Record<string, string[]> = {};
  for (const [power, list] of Object.entries(centers as Record<string, unknown>)) {
    if (Array.isArray(list)) out[power] = list.filter((c): c is string => typeof c === "string").map((c) => c.slice(0, 3).toUpperCase());
  }
  return out;
}

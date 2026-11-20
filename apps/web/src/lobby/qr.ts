/**
 * A table's invite link as a QR code, drawn as one SVG path. The encoder is uqr (no dependencies,
 * about 4.5 KB gzipped), loaded only when somebody asks to see the code, so the lobby pays nothing
 * for it until then.
 *
 * Each row of dark modules becomes a run of `h` strokes in one path: a few hundred characters
 * instead of hundreds of rectangles, and crisp at any size because every edge sits on the grid.
 */
import { encode } from "uqr";

export interface QrPath {
  /** Modules along one side, the quiet zone included. */
  size: number;
  /** One path; each dark run is a unit-high rectangle. */
  d: string;
  /** Dark modules drawn, for tests. */
  dark: number;
}

/** The four-module quiet zone the QR standard asks for around the symbol. */
export const QUIET = 4;

export function qrPath(text: string): QrPath {
  // Medium error correction: still reads with a thumb over a corner or a glare on the screen.
  const { data, size } = encode(text, { ecc: "M", border: QUIET });
  const parts: string[] = [];
  let dark = 0;
  for (let y = 0; y < size; y++) {
    const row = data[y]!;
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x++;
      dark += x - start;
      parts.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  }
  return { size, d: parts.join(""), dark };
}

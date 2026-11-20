import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { QUIET, qrPath } from "./qr.js";

const LINK = "https://playcabal.pages.dev/g/K7Q2XZ";

describe("qrPath", () => {
  it("draws exactly the encoder's dark modules, inside a four-module quiet zone", () => {
    const qr = qrPath(LINK);
    const { data } = encode(LINK, { ecc: "M", border: QUIET });
    expect(qr.size).toBe(data.length);
    expect(qr.dark).toBe(data.flat().filter(Boolean).length);
    // Nothing is drawn in the quiet zone.
    for (const m of qr.d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
      expect(x).toBeGreaterThanOrEqual(QUIET);
      expect(y).toBeGreaterThanOrEqual(QUIET);
      expect(x + w).toBeLessThanOrEqual(qr.size - QUIET);
    }
  });

  it("starts with the top left finder pattern: a full seven-module run", () => {
    const qr = qrPath(LINK);
    expect(qr.d.startsWith(`M${QUIET} ${QUIET}h7v1h-7z`)).toBe(true);
  });

  it("is small enough for a table link to scan from across a table", () => {
    // Version 3 (29 modules) holds a pages.dev link at medium correction; the quiet zone adds 8.
    expect(qrPath(LINK).size).toBeLessThanOrEqual(29 + 2 * QUIET);
  });

  it("gives a different symbol for a different table", () => {
    expect(qrPath(LINK).d).not.toBe(qrPath("https://playcabal.pages.dev/g/ABCDEF").d);
  });
});

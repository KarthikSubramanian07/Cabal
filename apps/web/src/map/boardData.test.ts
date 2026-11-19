import { describe, expect, it } from "vitest";
import board from "./board.json";
import { type Board, LABEL_OUTLINE_TOLERANCE, insideOutline, insideRings, outlineOf, pathRings } from "./boardData.js";
import { labelSize, layoutLabels, unitRadius } from "./view.js";

const data = board as unknown as Board;

describe("pathRings", () => {
  it("reads absolute starts, relative lines and several rings", () => {
    const rings = pathRings("M10 10l10 0l0 10l-10 0zM100 100l5 0l0 5z");
    expect(rings).toEqual([
      [
        [10, 10],
        [20, 10],
        [20, 20],
        [10, 20],
      ],
      [
        [100, 100],
        [105, 100],
        [105, 105],
      ],
    ]);
    expect(insideRings(rings, [15, 15])).toBe(true);
    expect(insideRings(rings, [25, 15])).toBe(false);
    expect(insideRings(rings, [104, 102])).toBe(true);
  });

  it("gives the same answers from the packed outline as from the rings", () => {
    for (const code of ["SPA", "STP", "NTH", "DEN", "CON"]) {
      const rings = pathRings(data.provinces[code]!.d);
      const packed = outlineOf(rings);
      const [ux, uy] = data.provinces[code]!.unit;
      for (let dx = -60; dx <= 60; dx += 7) {
        for (let dy = -60; dy <= 60; dy += 7) {
          expect(insideOutline(packed, ux + dx, uy + dy), `${code} ${dx},${dy}`).toBe(insideRings(rings, [ux + dx, uy + dy]));
        }
      }
    }
  });

  it("thins an outline without losing its shape", () => {
    const d = data.provinces["SPA"]!.d;
    const exact = pathRings(d);
    const rough = pathRings(d, LABEL_OUTLINE_TOLERANCE);
    const count = (rings: [number, number][][]) => rings.reduce((n, r) => n + r.length, 0);
    expect(count(rough)).toBeLessThan(count(exact) * 0.7);
    expect(count(rough)).toBeGreaterThan(12);
    expect(insideRings(rough, data.provinces["SPA"]!.unit)).toBe(true);
    expect(insideRings(rough, data.provinces["MAO"]!.unit)).toBe(false);
  });

  it("finds every province's piece position inside its own outline", () => {
    for (const [code, p] of Object.entries(data.provinces)) {
      if (p.kind === "impassable") continue;
      expect(insideRings(pathRings(p.d), p.unit), code).toBe(true);
    }
  });
});

describe("label layout on the real board", () => {
  const spots = Object.entries(data.provinces)
    .filter(([, p]) => p.kind !== "impassable")
    .map(([code, p]) => {
      // Laid out against the thinned outline, as Board.tsx does; judged against the true one.
      const rough = outlineOf(pathRings(p.d, LABEL_OUTLINE_TOLERANCE));
      const exact = pathRings(p.d);
      return {
        code,
        unit: p.unit,
        label: p.label,
        inside: (pt: [number, number]) => insideOutline(rough, pt[0], pt[1]),
        reallyInside: (pt: [number, number]) => insideRings(exact, pt),
      };
    });

  // Every zoom from a far-out overview to as close as the map goes, as Board.tsx sizes it.
  const sizes = new Map<string, readonly [number, number]>();
  for (let scale = 0.3; scale <= 6; scale *= 1.12) {
    const r = Math.round(unitRadius(scale) * 4) / 4;
    const size = Math.round(labelSize(scale) * 4) / 4;
    sizes.set(`${r}/${size}`, [r, size]);
  }
  for (const [r, size] of sizes.values()) {
    it(`writes every code inside the province it names (r ${r}, size ${size})`, () => {
      const at = layoutLabels(spots, r, size);
      const outside = spots.filter((s) => !s.reallyInside(at[s.code]!)).map((s) => s.code);
      expect(outside).toEqual([]);
    });

    it(`covers no piece position with a code (r ${r}, size ${size})`, () => {
      const at = layoutLabels(spots, r, size);
      const covered: string[] = [];
      for (const s of spots) {
        const [x, y] = at[s.code]!;
        for (const other of spots) {
          const dx = Math.max(Math.abs(other.unit[0] - x) - size * 1.02, 0);
          const dy = Math.max(Math.abs(other.unit[1] - y) - size * 0.45, 0);
          if (Math.hypot(dx, dy) < r * 0.9) covered.push(`${s.code} on ${other.code}`);
        }
      }
      expect(covered).toEqual([]);
    });
  }
});

import { describe, expect, it } from "vitest";
import standard from "../../../../crates/cabal-engine/data/maps/standard.json";
import geometry from "./board.json";
import { LABEL_OUTLINE_TOLERANCE, insideOutline, insideRings, outlineOf, pathRings } from "./boardData.js";
import { type BoardGeometry, composeBoard } from "./variant.js";
import { LABEL_CAP, boardSizes, leaderFor, placeLabels } from "./view.js";

const data = composeBoard(standard, geometry as unknown as BoardGeometry);

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
      const worth = p.sc ? 0 : p.kind === "sea" ? 2 : 1;
      // Laid out against the thinned outline, as Board.tsx does; judged against the true one.
      const rough = outlineOf(pathRings(p.d, LABEL_OUTLINE_TOLERANCE));
      const exact = pathRings(p.d);
      return {
        code,
        unit: p.unit,
        label: p.label,
        worth,
        keep: Boolean(p.sc),
        anchor: p.sc,
        inside: (pt: [number, number]) => insideOutline(rough, pt[0], pt[1]),
        reallyInside: (pt: [number, number]) => insideRings(exact, pt),
      };
    });

  // Every zoom from a far-out overview to as close as the map goes, as Board.tsx sizes it.
  const sizes = new Map<string, readonly [number, number]>();
  // From the whole board on the smallest phone to as close as the map goes.
  for (let scale = 0.26; scale <= 6; scale *= 1.12) {
    const { r, size } = boardSizes(scale);
    sizes.set(`${r}/${size}`, [r, size]);
  }
  for (const [r, size] of sizes.values()) {
    it(`writes every code inside the province it names, or a centre's right beside it (r ${r}, size ${size})`, () => {
      const at = placeLabels(spots, r, size);
      const outside = spots.filter((s) => at[s.code] && !s.reallyInside(at[s.code]!));
      if (size <= LABEL_CAP) {
        expect(outside.map((s) => s.code)).toEqual([]);
        return;
      }
      // A far-out overview sets a crowded centre's code beside its province, close to the centre.
      expect(outside.filter((s) => !s.keep).map((s) => s.code)).toEqual([]);
      for (const s of outside) {
        const leader = leaderFor(at[s.code]!, s.anchor!, size);
        const length = leader ? Math.hypot(leader[1][0] - leader[0][0], leader[1][1] - leader[0][1]) : 0;
        expect(length, s.code).toBeLessThan(size * 2.5);
      }
    });

    it(`names every supply centre (r ${r}, size ${size})`, () => {
      const at = placeLabels(spots, r, size);
      expect(spots.filter((s) => s.keep && !at[s.code]).map((s) => s.code)).toEqual([]);
    });

    it(`writes no code's letters over another's (r ${r}, size ${size})`, () => {
      const at = placeLabels(spots, r, size);
      const codes = Object.keys(at);
      const clashes: string[] = [];
      for (const [i, a] of codes.entries()) {
        for (const b of codes.slice(i + 1)) {
          const [ax, ay] = at[a]!;
          const [bx, by] = at[b]!;
          // The letters themselves (three mono capitals), as e2e/layout.spec.ts measures them.
          if (Math.abs(ax - bx) < size * 1.86 && Math.abs(ay - by) < size * 0.72) clashes.push(`${a} on ${b}`);
        }
      }
      expect(clashes).toEqual([]);
    });

    it(`covers no piece position with a code (r ${r}, size ${size})`, () => {
      const at = placeLabels(spots, r, size);
      const covered: string[] = [];
      for (const s of spots) {
        if (!at[s.code]) continue;
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

  it("draws every code up to the cap, and on a far-out overview every supply centre's and leaves out only lesser ones", () => {
    const { r, size } = boardSizes(1);
    expect(Object.keys(placeLabels(spots, r, size))).toHaveLength(spots.length);
    const far = boardSizes(0.26);
    expect(far.size).toBeGreaterThan(16);
    const at = placeLabels(spots, far.r, far.size);
    const centres = spots.filter((s) => s.worth === 0);
    // Central Europe included: the Low Countries, Berlin, Vienna, Venice and Rome.
    expect(centres.filter((s) => !at[s.code]).map((s) => s.code)).toEqual([]);
    for (const code of ["HOL", "BEL", "BER", "KIE", "VIE", "VEN", "ROM", "LON"]) expect(at[code], code).toBeDefined();
    expect(Object.keys(at).length).toBeLessThan(spots.length);
  });
});

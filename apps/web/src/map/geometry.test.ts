import { describe, expect, it } from "vitest";
import type { Point } from "./boardData.js";
import {
  MAX_BOW,
  bowed,
  convoyedArrow,
  dist,
  markSizes,
  moveArrow,
  quadPoint,
  quadSlice,
  quadTangent,
  supportHoldArrow,
  supportMoveArrow,
  track,
  trackPoint,
  trim,
} from "./geometry.js";

const close = (p: Point, q: Point, eps = 0.05) => expect(dist(p, q)).toBeLessThan(eps);
const nums = (s: string) => s.split(/[ ,]/).map(Number);

describe("move arrows", () => {
  it("bow to the left of the direction of travel, so a swap draws two arcs", () => {
    const east = bowed([0, 0], [100, 0]);
    const west = bowed([100, 0], [0, 0]);
    // Screen y grows downwards: left of an eastward move is up (negative y).
    expect(east.c[1]).toBeLessThan(0);
    expect(west.c[1]).toBeGreaterThan(0);
  });

  it("cap the bow on long moves", () => {
    const q = bowed([0, 0], [1000, 0]);
    expect(Math.abs(q.c[1])).toBeCloseTo(MAX_BOW);
  });

  it("leave the piece's edge and stop short of the destination's centre", () => {
    const r = 10;
    const a = moveArrow([0, 0], [120, 0], r);
    const s = markSizes(r);
    expect(dist(a.drawn.a, [0, 0])).toBeCloseTo(s.leave, 0);
    expect(dist(a.drawn.b, [120, 0])).toBeCloseTo(s.arrive, 0);
  });

  it("put the head's tip at the end of the drawn curve, pointing along it", () => {
    const a = moveArrow([0, 0], [120, 40], 9);
    const [tx, ty] = nums(a.head);
    close([tx!, ty!], a.drawn.b);
    // The head has four points: tip, wing, notch, wing.
    expect(nums(a.head)).toHaveLength(8);
    const dir = quadTangent(a.drawn, 1);
    const notch: Point = [nums(a.head)[4]!, nums(a.head)[5]!];
    // The notch sits behind the tip along the curve's last direction.
    const back: Point = [a.drawn.b[0] - notch[0], a.drawn.b[1] - notch[1]];
    expect(back[0] * dir[0] + back[1] * dir[1]).toBeGreaterThan(0);
  });

  it("scale with the piece radius, so they read the same at every zoom", () => {
    const small = markSizes(6.5);
    const big = markSizes(12.5);
    expect(big.head / small.head).toBeGreaterThan(1.5);
    expect(big.knot).toBeGreaterThan(small.knot);
  });

  it("march from centre to centre along the same bow", () => {
    const a = moveArrow([0, 0], [100, 0], 9);
    close(trackPoint(a.path, 0), [0, 0]);
    close(trackPoint(a.path, 1), [100, 0]);
    // Half way it is out on the bow, not on the straight line.
    expect(trackPoint(a.path, 0.5)[1]).toBeLessThan(-5);
  });
});

describe("support arrows", () => {
  it("bend in to the middle of the move they back", () => {
    const move = moveArrow([0, 0], [100, 0], 9);
    const s = supportMoveArrow([50, 80], move.drawn, 9);
    close(s.knot.at, quadPoint(move.drawn, 0.5));
  });

  it("stop at the ring round a unit they hold up", () => {
    const s = supportHoldArrow([0, 0], [100, 0], 9);
    expect(dist(s.knot.at, [100, 0])).toBeCloseTo(markSizes(9).ring, 0);
  });
});

describe("moves by convoy", () => {
  it("pass through every carrying fleet and land at the destination", () => {
    const fleets: Point[] = [
      [100, 0],
      [200, 50],
    ];
    const a = convoyedArrow([0, 0], fleets, [300, 0], 9);
    close(trackPoint(a.path, 0), [0, 0]);
    close(trackPoint(a.path, 1), [300, 0]);
    expect(a.d.match(/Q/g)).toHaveLength(2);
  });
});

describe("curve helpers", () => {
  it("slice a curve without moving its points", () => {
    const q = bowed([0, 0], [100, 0]);
    const s = quadSlice(q, 0.2, 0.7);
    close(s.a, quadPoint(q, 0.2));
    close(s.b, quadPoint(q, 0.7));
    close(quadPoint(s, 0.5), quadPoint(q, 0.45), 0.5);
  });

  it("trim by length from each end", () => {
    const q = bowed([0, 0], [100, 0], 0);
    const t = trim(q, 10, 20);
    close(t.a, [10, 0], 0.5);
    close(t.b, [80, 0], 0.5);
  });

  it("walk a track at an even pace", () => {
    const tr = track([bowed([0, 0], [50, 0], 0), bowed([50, 0], [150, 0], 0)]);
    close(trackPoint(tr, 0.5), [75, 0], 0.5);
    close(trackPoint(tr, 2), [150, 0]);
  });
});

import { describe, expect, it } from "vitest";
import type { Point } from "./boardData.js";
import { dist, moveArrow, quadPoint } from "./geometry.js";
import { convoyRoutes, layoutMarks } from "./marks.js";

const P: Record<string, Point> = {
  PAR: [100, 100],
  BUR: [200, 100],
  MAR: [150, 200],
  PIC: [100, 0],
  LON: [100, -200],
  ENG: [80, -100],
  NTH: [200, -150],
  BEL: [180, -40],
  BRE: [0, 60],
};
const point = (region: string): Point => P[region.slice(0, 3)] ?? [0, 0];
const r = 9;

describe("layoutMarks", () => {
  it("gives every kind of order its own shape", () => {
    const marks = layoutMarks(
      ["A PAR - BUR", "A MAR S A PAR - BUR", "F BRE H", "F ENG C A LON - BEL", "A PAR B", "F BRE D", "WAIVE", "nonsense"],
      point,
      r,
    );
    expect(marks.map((m) => m?.shape.kind ?? null)).toEqual(["arrow", "helper", "ring", "helper", "build", "disband", null, null]);
    expect(marks[1]!.shape.kind === "helper" && marks[1]!.shape.cls).toBe("support");
    expect(marks[3]!.shape.kind === "helper" && marks[3]!.shape.cls).toBe("convoy");
  });

  it("aims a support at the drawn middle of the move it backs", () => {
    const [, support] = layoutMarks(["A PAR - BUR", "A MAR S A PAR - BUR"], point, r);
    const move = moveArrow(point("PAR"), point("BUR"), r).drawn;
    if (support?.shape.kind !== "helper") throw new Error("expected a helper");
    expect(dist(support.shape.knot.at, quadPoint(move, 0.5))).toBeLessThan(0.01);
  });

  it("aims at the move as it would be drawn when the backed unit did something else", () => {
    const [support] = layoutMarks(["A MAR S A PAR - BUR"], point, r);
    const move = moveArrow(point("PAR"), point("BUR"), r).drawn;
    if (support?.shape.kind !== "helper") throw new Error("expected a helper");
    expect(dist(support.shape.knot.at, quadPoint(move, 0.5))).toBeLessThan(0.01);
  });

  it("draws a move by convoy through its fleets and rings the fleets instead of lining them", () => {
    const texts = ["A LON - BEL VIA", "F ENG C A LON - BEL", "F NTH C A LON - BEL"];
    const [move, eng, nth] = layoutMarks(texts, point, r);
    expect(move?.shape.kind === "arrow" && move.shape.cls).toBe("move via routed");
    expect(eng?.shape.kind === "ring" && eng.shape.cls).toBe("convoy carrying");
    expect(nth?.shape.kind === "ring" && nth.shape.cls).toBe("convoy carrying");
    expect(convoyRoutes(texts, point).get("A LON - BEL VIA")).toEqual(["ENG", "NTH"]);
  });

  it("marks a move by convoy nobody carries as a via move, and a retreat as a retreat", () => {
    const [via, retreat] = layoutMarks(["A LON - BEL VIA", "A BUR R PAR"], point, r);
    expect(via?.shape.kind === "arrow" && via.shape.cls).toBe("move via");
    expect(retreat?.shape.kind === "arrow" && retreat.shape.cls).toBe("retreat");
  });
});

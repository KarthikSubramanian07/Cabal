import { describe, expect, it } from "vitest";
import type { Point } from "./boardData.js";
import { carryingOrders, convoyChain, smoothPath } from "./route.js";

// A strip of sea from London eastwards: LON, ENG, NTH, HEL, DEN.
const at: Record<string, Point> = { LON: [0, 0], ENG: [10, 0], NTH: [20, 0], HEL: [30, 0], DEN: [40, 0], WAL: [-10, 0] };
const point = (region: string) => at[region.slice(0, 3)]!;

describe("the route of a move by convoy", () => {
  it("passes the carrying fleets from the army outwards, whatever order they were written in", () => {
    const orders = ["F HEL C A LON - DEN", "A LON - DEN VIA", "F ENG C A LON - DEN", "F NTH C A LON - DEN"];
    expect(convoyChain("A LON - DEN VIA", orders, point)).toEqual(["ENG", "NTH", "HEL"]);
  });

  it("ignores fleets convoying another army or to another place", () => {
    const orders = ["A LON - DEN VIA", "F ENG C A WAL - DEN", "F NTH C A LON - HEL", "F HEL C A LON - DEN"];
    expect(convoyChain("A LON - DEN VIA", orders, point)).toEqual(["HEL"]);
  });

  it("has no route for a move by land, or before any fleet is ordered", () => {
    expect(convoyChain("A LON - WAL", ["F ENG C A LON - WAL"], point)).toEqual([]);
    expect(convoyChain("A LON - DEN VIA", ["A LON - DEN VIA"], point)).toEqual([]);
  });

  it("marks the convoys whose army is drawn through them", () => {
    const orders = ["A LON - DEN VIA", "F ENG C A LON - DEN", "F NTH C A WAL - DEN", "F HEL H"];
    expect([...carryingOrders(orders)]).toEqual(["F ENG C A LON - DEN"]);
  });
});

describe("smoothPath", () => {
  it("is a straight line between two points", () => {
    expect(smoothPath([[0, 0], [10, 5]])).toBe("M0 0 L10 5");
  });

  it("bends at each stop and ends on the last point", () => {
    expect(smoothPath([[0, 0], [10, 0], [20, 10], [30, 10]])).toBe("M0 0 Q10 0 15 5 Q20 10 30 10");
  });

  it("draws nothing for a single point", () => {
    expect(smoothPath([[1, 1]])).toBe("");
  });
});

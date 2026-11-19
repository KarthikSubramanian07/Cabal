import { describe, expect, it } from "vitest";
import {
  READABLE_SCALE,
  clampView,
  fitsWhole,
  homeView,
  isWholeView,
  labelSize,
  layoutLabels,
  placeLabel,
  resolveTap,
  unitRadius,
  wholeView,
  zoomView,
} from "./view.js";

const board = { w: 1200, h: 1169.4 };
const desktop = { w: 770, h: 750.4 };
const phone = { w: 390, h: 470 };
const landscape = { w: 520, h: 290 };

describe("wholeView", () => {
  it("is the board itself in a frame of the board's shape", () => {
    const v = wholeView(board, desktop);
    expect(v.x).toBeCloseTo(0, 0);
    expect(v.y).toBeCloseTo(0, 0);
    expect(v.w).toBeCloseTo(1200, 0);
  });

  it("letterboxes a frame of another shape and keeps everything in view", () => {
    for (const frame of [phone, landscape]) {
      const v = wholeView(board, frame);
      expect(v.w / v.h).toBeCloseTo(frame.w / frame.h, 5);
      expect(v.x).toBeLessThanOrEqual(0.001);
      expect(v.y).toBeLessThanOrEqual(0.001);
      expect(v.x + v.w).toBeGreaterThanOrEqual(board.w - 0.001);
      expect(v.y + v.h).toBeGreaterThanOrEqual(board.h - 0.001);
    }
  });
});

describe("homeView", () => {
  const france: [number, number][] = [
    [330, 520],
    [300, 480],
    [395, 590],
  ];

  it("shows the whole board when it is readable", () => {
    expect(fitsWhole(board, desktop)).toBe(true);
    expect(isWholeView(board, desktop, homeView(board, desktop, france))).toBe(true);
  });

  it("shows the whole board on a short laptop screen, where it is small but complete", () => {
    // What the layout gives the board at 1280x720 and 1366x768.
    for (const frame of [
      { w: 585, h: 570 },
      { w: 634, h: 618 },
    ]) {
      expect(fitsWhole(board, frame)).toBe(true);
      expect(isWholeView(board, frame, homeView(board, frame, france))).toBe(true);
      const scale = frame.w / wholeView(board, frame).w;
      expect(labelSize(scale) * scale).toBeGreaterThanOrEqual(7.5);
    }
  });

  it("opens a phone on the active power's theatre at a readable scale", () => {
    expect(fitsWhole(board, phone)).toBe(false);
    for (const frame of [phone, landscape]) {
      const v = homeView(board, frame, france);
      expect(frame.w / v.w).toBeCloseTo(READABLE_SCALE, 5);
      expect(isWholeView(board, frame, v)).toBe(false);
      for (const [x, y] of france) {
        expect(x).toBeGreaterThan(v.x);
        expect(x).toBeLessThan(v.x + v.w);
        expect(y).toBeGreaterThan(v.y);
        expect(y).toBeLessThan(v.y + v.h);
      }
      // never pans off the map
      expect(v.x).toBeGreaterThanOrEqual(0);
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.x + v.w).toBeLessThanOrEqual(board.w + 0.001);
    }
  });

  it("falls back to the whole board with nothing to focus on", () => {
    expect(isWholeView(board, phone, homeView(board, phone, []))).toBe(true);
  });
});

describe("zoomView and clampView", () => {
  it("keeps the point under the cursor fixed", () => {
    const start = wholeView(board, desktop);
    const at: [number, number] = [300, 500];
    const v = zoomView(board, desktop, start, 2, at);
    expect(v.w).toBeCloseTo(start.w / 2, 5);
    expect((at[0] - v.x) / v.w).toBeCloseTo((at[0] - start.x) / start.w, 5);
    expect((at[1] - v.y) / v.h).toBeCloseTo((at[1] - start.y) / start.h, 5);
  });

  it("stops at eight times and at the whole board", () => {
    const whole = wholeView(board, desktop);
    expect(zoomView(board, desktop, whole, 100).w).toBeCloseTo(board.w / 8, 5);
    expect(zoomView(board, desktop, zoomView(board, desktop, whole, 3), 1 / 100).w).toBeCloseTo(whole.w, 5);
  });

  it("never lets a zoomed view leave the board", () => {
    const v = clampView(board, desktop, { x: -500, y: 5000, w: 400, h: 400 });
    expect(v.x).toBe(0);
    expect(v.y + v.h).toBeCloseTo(board.h, 5);
    expect(v.w / v.h).toBeCloseTo(desktop.w / desktop.h, 5);
  });
});

describe("sizes", () => {
  it("keeps province codes readable at the default zoom on a desktop and on a phone", () => {
    const desktopScale = desktop.w / wholeView(board, desktop).w;
    const phoneScale = phone.w / homeView(board, phone, [[330, 520]]).w;
    for (const scale of [desktopScale, phoneScale]) {
      expect(labelSize(scale) * scale).toBeGreaterThanOrEqual(9.9);
      expect(unitRadius(scale) * scale * 2).toBeGreaterThanOrEqual(15);
    }
  });

  it("shrinks in board units as the player zooms in, but grows on screen", () => {
    expect(labelSize(2)).toBeLessThan(labelSize(0.62));
    expect(labelSize(2) * 2).toBeGreaterThan(labelSize(0.62) * 0.62);
    expect(unitRadius(2)).toBeLessThan(unitRadius(0.62));
    expect(unitRadius(4) * 4).toBeGreaterThan(unitRadius(0.62) * 0.62);
  });

  it("is capped so a far-out overview does not turn into a wall of text", () => {
    expect(labelSize(0.2)).toBeLessThanOrEqual(16);
    expect(unitRadius(0.2)).toBeLessThanOrEqual(12.5);
  });
});

describe("placeLabel", () => {
  it("moves a code clear of the piece along the map maker's direction", () => {
    const [x, y] = placeLabel([100, 100], [100, 116], 12, 14);
    expect(x).toBe(100);
    expect(y - 100).toBeCloseTo(12 * 1.1 + 14 * 0.62 + 1.5, 5);
    const above = placeLabel([100, 100], [100, 84], 12, 14);
    expect(above[1]).toBeLessThan(84);
  });

  it("puts a coincident code below the piece and leaves a clear one alone", () => {
    expect(placeLabel([100, 100], [100, 100], 12, 14)[1]).toBeGreaterThan(113);
    expect(placeLabel([100, 100], [100, 160], 12, 14)).toEqual([100, 160]);
  });
});

describe("resolveTap", () => {
  const candidates = [
    { code: "PAR", at: [330, 520] as [number, number] },
    { code: "BUR", at: [380, 530] as [number, number] },
  ];

  it("keeps the province under the finger when it can be acted on", () => {
    expect(resolveTap([335, 522], "PAR", candidates, 30)).toBe("PAR");
  });

  it("snaps a near miss to the nearest province that can be acted on", () => {
    expect(resolveTap([345, 505], "PIC", candidates, 30)).toBe("PAR");
    expect(resolveTap([372, 540], "GAS", candidates, 30)).toBe("BUR");
    expect(resolveTap([372, 540], null, candidates, 30)).toBe("BUR");
  });

  it("leaves a tap far from anything alone", () => {
    expect(resolveTap([600, 900], "TUN", candidates, 30)).toBe("TUN");
    expect(resolveTap([600, 900], null, candidates, 30)).toBeNull();
    expect(resolveTap([345, 505], "PIC", [], 30)).toBe("PIC");
  });
});

describe("layoutLabels", () => {
  const overlap = (a: [number, number], b: [number, number], size: number) =>
    Math.abs(a[0] - b[0]) < size * 2.04 && Math.abs(a[1] - b[1]) < size * 0.9;

  it("keeps the map maker's side when there is room", () => {
    const out = layoutLabels([{ code: "PAR", unit: [330, 520], label: [330, 536] }], 12, 14);
    expect(out["PAR"]![0]).toBe(330);
    expect(out["PAR"]![1]).toBeGreaterThan(532);
  });

  it("moves a code that would sit on a neighbouring piece or another code", () => {
    // Two provinces side by side, both labelled underneath: the codes would run together.
    const spots = [
      { code: "LVP", unit: [300, 400] as [number, number], label: [300, 416] as [number, number] },
      { code: "YOR", unit: [330, 400] as [number, number], label: [330, 416] as [number, number] },
    ];
    const out = layoutLabels(spots, 12, 14);
    expect(overlap(out["LVP"]!, out["YOR"]!, 14)).toBe(false);
    // and neither code covers the other province's piece
    for (const [code, other] of [["LVP", spots[1]!], ["YOR", spots[0]!]] as const) {
      const at = out[code]!;
      expect(Math.hypot(at[0] - other.unit[0], at[1] - other.unit[1])).toBeGreaterThan(12);
    }
  });

  it("keeps a code inside its own province when the preferred side falls outside it", () => {
    // A province that only extends upwards from where the piece stands.
    const inside = ([x, y]: [number, number]) => x > 70 && x < 130 && y > 20 && y < 108;
    const out = layoutLabels([{ code: "KIE", unit: [100, 100], label: [100, 116], inside }], 12, 14);
    expect(inside(out["KIE"]!)).toBe(true);
    expect(out["KIE"]![1]).toBeLessThan(100);
  });

  it("is stable: the same input gives the same layout", () => {
    const spots = [
      { code: "A", unit: [0, 0] as [number, number], label: [0, 16] as [number, number] },
      { code: "B", unit: [20, 5] as [number, number], label: [20, 21] as [number, number] },
    ];
    expect(layoutLabels(spots, 12, 14)).toEqual(layoutLabels(spots, 12, 14));
  });
});

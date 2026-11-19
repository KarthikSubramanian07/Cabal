import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, type PhaseOutcome, type State, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { trackUnits } from "../game/unitIds.js";
import type { Point } from "../map/boardData.js";
import {
  BOUNCE_REACH,
  DISSOLVE_MS,
  LEAD_MS,
  MARCH_MS,
  type ResolutionInput,
  STAMP_MS,
  choreograph,
  resolutionLength,
  standAside,
  trackAt,
} from "./choreography.js";

beforeAll(async () => {
  await ready(readFileSync(fileURLToPath(new URL("../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url))));
});

/** A toy map: every province on a grid, so positions are easy to reason about. */
const GRID: Record<string, Point> = {};
const codes = "PAR BUR MUN MAR PIC BRE GAS RUH KIE BER SIL PRU WAR MOS LVN STP FIN SWE NWY DEN HOL BEL LON YOR WAL EDI LVP CLY NTH ENG IRI MAO NAO NWG BAR SKA HEL BAL BOT TYR VIE BOH GAL BUD TRI SER RUM UKR SEV ARM ANK CON SMY SYR BUL GRE ALB VEN ROM APU NAP TUS PIE ADR ION TYS GOL WES LYO NAF TUN EAS AEG BLA SPA POR".split(" ");
codes.forEach((c, i) => (GRID[c] = [(i % 10) * 100, Math.floor(i / 10) * 100]));
const point = (region: string): Point => GRID[region.slice(0, 3)] ?? [0, 0];
const r = 10;

/** Play `orders` from the opening and return what the board would be given. */
function phase(orders: Record<string, string[]>, game = new Game()) {
  const before = game.state();
  const outcome: PhaseOutcome = game.process({ orders });
  const after = game.state();
  const ids = trackUnits([{ state: before, outcome }], after);
  const input: ResolutionInput = {
    phase: outcome.phase,
    before,
    after,
    results: outcome.results,
    beforeIds: ids.phases[0],
    afterIds: ids.live,
  };
  const written = new Set(Object.values(orders).flat());
  const marks = outcome.results
    .filter((res) => written.has(res.order) || !res.ok)
    .map((res) => ({ text: res.order, ok: res.ok }));
  return { input, marks, outcome, game, after };
}

const unitOf = (c: ReturnType<typeof choreograph>, unit: string) => c.units.find((u) => u.unit === unit)!;
const at = (f: { x: number; y: number }): Point => [f.x, f.y];

describe("a movement phase", () => {
  it("marches a successful move along its arrow and ends on its new province", () => {
    const { input, marks } = phase({ FRANCE: ["A PAR - BUR"] });
    const c = choreograph(input, marks, { point, r });
    const par = unitOf(c, "A PAR");
    expect(par.role).toBe("march");
    expect(at(par.frames[0]!)).toEqual(point("PAR"));
    expect(at(par.frames.at(-1)!)).toEqual(point("BUR"));
    expect(par.end).toEqual(point("BUR"));
    // The ink leads: the piece sets off after its arrow starts to draw.
    expect(par.frames[0]!.t).toBe(c.marks[0]!.delay + LEAD_MS);
    expect(par.frames.at(-1)!.t - par.frames[0]!.t).toBe(MARCH_MS);
  });

  it("sends a bounced move part of the way and back, then stamps the failure", () => {
    const { input, marks } = phase({ FRANCE: ["A PAR - BUR"], GERMANY: ["A MUN - BUR"] });
    const c = choreograph(input, marks, { point, r });
    const par = unitOf(c, "A PAR");
    expect(par.role).toBe("bounce");
    expect(par.gone).toBe(false);
    const xs = par.frames.map((f) => f.x);
    const reach = Math.max(...xs) - point("PAR")[0];
    const full = point("BUR")[0] - point("PAR")[0];
    expect(reach / full).toBeGreaterThan(BOUNCE_REACH * 0.8);
    expect(reach / full).toBeLessThan(BOUNCE_REACH * 1.3);
    expect(at(par.frames.at(-1)!)).toEqual(point("PAR"));
    // Both failures are stamped, after the last impact, one after the other.
    const stamps = c.marks.map((m) => m.stamp);
    expect(stamps[0]).toBeGreaterThanOrEqual(c.beats.verdict);
    expect(new Set(stamps).size).toBe(2);
    expect(c.total).toBe(Math.max(...stamps) + STAMP_MS);
    expect(c.cues.filter((q) => q.sound === "thud")).toHaveLength(2);
  });

  it("knocks a dislodged unit aside as its attacker arrives", () => {
    const g2 = new Game();
    g2.process({ orders: { GERMANY: ["A MUN - BUR"], FRANCE: ["A MAR - GAS"] } });
    g2.process({ orders: {} });
    const hit = phase({ FRANCE: ["A PAR - BUR", "A GAS S A PAR - BUR"], GERMANY: ["A BUR H"] }, g2);
    const c = choreograph(hit.input, hit.marks, { point, r });
    const bur = unitOf(c, "A BUR");
    expect(bur.role).toBe("knocked");
    expect(bur.dislodged).toBe(true);
    expect(bur.end).toEqual(standAside(point("BUR"), r));
    const par = unitOf(c, "A PAR");
    // The knock comes when the attacker lands.
    expect(bur.turnsAt).toBe(par.frames.at(-1)!.t);
    expect(c.cues.some((q) => q.sound === "thud" && (q.weight ?? 1) > 1)).toBe(true);
  });

  it("leaves units that held where they are, with no frames", () => {
    const { input, marks } = phase({ FRANCE: ["A PAR H"] });
    const c = choreograph(input, marks, { point, r });
    expect(unitOf(c, "A PAR").role).toBe("still");
    expect(unitOf(c, "A PAR").frames).toEqual([]);
    expect(unitOf(c, "F LON").frames).toEqual([]);
  });

  it("inks the units that stood before the moves, and opens with the seals breaking", () => {
    const { input, marks } = phase({ FRANCE: ["A PAR - BUR", "A MAR S A PAR - BUR"] });
    const c = choreograph(input, marks, { point, r });
    const move = marks.findIndex((m) => m.text === "A PAR - BUR");
    const support = marks.findIndex((m) => m.text.startsWith("A MAR S"));
    expect(c.marks[support]!.delay).toBeLessThan(c.marks[move]!.delay);
    expect(c.cues[0]).toEqual({ at: 0, sound: "crack" });
    expect(c.cues.map((q) => q.sound)).toContain("quill");
    expect(c.cues.map((q) => q.sound)).toContain("march");
    expect(c.cues.at(-1)!.sound).toBe("tick");
  });
});

describe("retreats and adjustments", () => {
  /** A position with a German army dislodged from Burgundy, and the retreat phase it opens. */
  function dislodged() {
    const g = new Game();
    g.process({ orders: { GERMANY: ["A MUN - BUR"], FRANCE: ["A MAR - GAS"] } });
    g.process({ orders: {} });
    g.process({ orders: { FRANCE: ["A PAR - BUR", "A GAS S A PAR - BUR"], GERMANY: ["A BUR H"] } });
    return g;
  }

  it("walks a retreating unit from where it stood aside to its new province", () => {
    const g = dislodged();
    expect(g.phase()).toMatch(/R$/);
    const { input, marks } = phase({ GERMANY: ["A BUR R MUN"] }, g);
    const c = choreograph(input, marks, { point, r });
    const bur = c.units.find((u) => u.power === "GERMANY" && u.role === "retreat")!;
    expect(at(bur.frames[0]!)).toEqual(standAside(point("BUR"), r));
    expect(bur.end).toEqual(point("MUN"));
    expect(bur.dislodged).toBe(false);
  });

  it("fades out a unit that disbands", () => {
    const g = dislodged();
    const { input, marks } = phase({ GERMANY: ["A BUR D"] }, g);
    const c = choreograph(input, marks, { point, r });
    const gone = c.units.filter((u) => u.gone);
    expect(gone).toHaveLength(1);
    expect(gone[0]!.frames.at(-1)!.opacity).toBe(0);
  });

  it("names the dislodged unit, not the one that took its place, for a province both stood in", () => {
    for (const orders of [{}, { GERMANY: ["A BUR R MUN"] }]) {
      const g = dislodged();
      // Before this phase Burgundy holds the French army that took it and the German one beaten out.
      const { input, marks } = phase(orders, g);
      const c = choreograph(input, marks, { point, r });
      const picked = trackAt(c, "BUR")!;
      expect(picked.power).toBe("GERMANY");
      expect(picked.wasDislodged).toBe(true);
    }
  });

  it("names the one unit that began a movement phase in a province", () => {
    const { input, marks } = phase({ FRANCE: ["A PAR - BUR"], GERMANY: ["A MUN - RUH"] });
    const c = choreograph(input, marks, { point, r });
    expect(trackAt(c, "PAR")?.power).toBe("FRANCE");
    expect(trackAt(c, "BUR")).toBeUndefined();
  });

  it("stamps in a new build", () => {
    const g = new Game();
    g.process({ orders: { FRANCE: ["A PAR - PIC", "F BRE - MAO", "A MAR - SPA"] } });
    g.process({ orders: { FRANCE: ["A PIC - BEL", "F MAO - POR", "A SPA H"] } });
    expect(g.phase()).toMatch(/A$/);
    const { input, marks } = phase({ FRANCE: ["A PAR B", "F BRE B"] }, g);
    const c = choreograph(input, marks, { point, r });
    const builds = c.units.filter((u) => u.role === "build");
    expect(builds).toHaveLength(2);
    for (const b of builds) {
      expect(b.frames[0]!.opacity).toBe(0);
      expect(b.frames[0]!.scale).toBeGreaterThan(1.5);
      expect(b.frames.at(-1)!.scale).toBe(1);
    }
    expect(c.cues.filter((q) => q.sound === "thud").length).toBeGreaterThanOrEqual(2);
  });
});

describe("reduced motion", () => {
  it("dissolves moved pieces in place and travels nowhere", () => {
    const { input, marks } = phase({ FRANCE: ["A PAR - BUR"], GERMANY: ["A MUN - BUR"], ENGLAND: ["F LON - NTH"] });
    const c = choreograph(input, marks, { point, r }, { reduced: true });
    expect(c.total).toBe(DISSOLVE_MS);
    for (const u of c.units) {
      // Every frame is at the start or at the end: nothing in between.
      for (const f of u.frames) {
        const p = at(f);
        const ok = p[0] === u.end[0] && p[1] === u.end[1] ? true : u.frames.some((g) => g.t === 0 && g.x === f.x && g.y === f.y);
        expect(ok).toBe(true);
      }
    }
    const lon = unitOf(c, "F LON");
    expect(lon.frames.map((f) => f.opacity)).toEqual([1, 0, 0, 1]);
    expect(c.marks.every((m) => m.delay === 0)).toBe(true);
  });
});

describe("resolutionLength", () => {
  it("is the same with or without the map's geometry", () => {
    const { input, marks } = phase({ FRANCE: ["A PAR - BUR"], GERMANY: ["A MUN - BUR"] });
    expect(resolutionLength(input, marks)).toBe(choreograph(input, marks, { point, r }).total);
    expect(resolutionLength(input, [], true)).toBe(DISSOLVE_MS);
  });

  it("has nothing to play when nothing happened", () => {
    const s: State = new Game().state();
    expect(resolutionLength({ phase: "S1901M", before: s, after: s, results: [] }, [])).toBe(0);
  });
});

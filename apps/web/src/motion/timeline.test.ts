import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { type TimelineRecord, headlineOf, summarise, timeline } from "./timeline.js";

beforeAll(async () => {
  await ready(readFileSync(fileURLToPath(new URL("../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url))));
});

function play(phases: Record<string, string[]>[]): TimelineRecord[] {
  const g = new Game();
  return phases.map((orders) => {
    const state = g.state();
    const phase = g.phase();
    const outcome = g.process({ orders });
    return { phase, state, outcome };
  });
}

describe("timeline", () => {
  it("marks each phase by what happened in it", () => {
    const marks = timeline(
      play([
        { FRANCE: ["A PAR - BUR"], GERMANY: ["A MUN - BUR"], ENGLAND: ["F LON - NTH"] },
        { GERMANY: ["A MUN - BUR"], FRANCE: ["A MAR - BUR", "A PAR S A MAR - BUR"], ENGLAND: ["F NTH - HOL"] },
        { ENGLAND: ["F LON B"] },
      ]),
    );
    expect(marks.map((m) => m.phase)).toEqual(["S1901M", "F1901M", "W1901A"]);
    expect(marks[0]!.headline).toBe("standoffs");
    expect(marks[0]!.summary).toBe("1 standoff");
    // Holland taken in the fall: a centre changes hands; the build comes in winter.
    expect(marks[1]!.events.captures).toBeGreaterThanOrEqual(1);
    expect(marks[2]!.events.builds).toBe(1);
    expect(marks[2]!.headline).toBe("builds");
    expect(marks[0]!.season).toBe("Spring");
    expect(marks[0]!.year).toBe("1901");
  });

  it("puts the worst news first", () => {
    const e = { captures: 2, dislodged: 1, standoffs: 1, builds: 0, disbands: 0, eliminated: ["ITALY"], ended: null };
    expect(headlineOf(e)).toBe("eliminated");
    expect(summarise(e)).toBe("Italy eliminated, 1 unit dislodged, 2 centres changed hands, 1 standoff");
    expect(headlineOf({ ...e, ended: "solo:FRANCE" })).toBe("ended");
    expect(summarise({ ...e, eliminated: [], ended: "solo:FRANCE", dislodged: 0, captures: 0, standoffs: 0 })).toBe("France wins");
    expect(headlineOf({ captures: 0, dislodged: 0, standoffs: 0, builds: 0, disbands: 0, eliminated: [], ended: null })).toBeNull();
  });
});

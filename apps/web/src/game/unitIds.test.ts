import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, type PhaseOutcome, type State, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { trackUnits, unitKey } from "./unitIds.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

interface Record {
  state: State;
  outcome: PhaseOutcome;
}

function play(game: Game, orders: { [power: string]: string[] }, history: Record[]) {
  const state = game.state();
  const outcome = game.process(game.normaliseOrders({ orders }));
  history.push({ state, outcome });
}

describe("trackUnits", () => {
  it("gives every unit of the opening position its own id", () => {
    const game = new Game();
    const { live, phases } = trackUnits([], game.state());
    expect(phases).toEqual([]);
    expect(Object.keys(live)).toHaveLength(22);
    expect(new Set(Object.values(live)).size).toBe(22);
  });

  it("follows a unit through a move and keeps the ids of those that stay or bounce", () => {
    const game = new Game();
    const history: Record[] = [];
    play(game, { FRANCE: ["A PAR - BUR", "A MAR - SPA"], GERMANY: ["A MUN - BUR"] }, history);
    const { phases, live } = trackUnits(history, game.state());
    const before = phases[0]!;
    // Paris and Munich bounced in Burgundy: both are where they were, with the ids they had.
    expect(live[unitKey("FRANCE", "A PAR")]).toBe(before[unitKey("FRANCE", "A PAR")]);
    expect(live[unitKey("GERMANY", "A MUN")]).toBe(before[unitKey("GERMANY", "A MUN")]);
    // Marseilles marched to Spain: a new name, the same piece.
    expect(live[unitKey("FRANCE", "A SPA")]).toBe(before[unitKey("FRANCE", "A MAR")]);
    expect(live[unitKey("FRANCE", "A MAR")]).toBeUndefined();
    expect(new Set(Object.values(live)).size).toBe(22);
  });

  it("keeps identity through dislodgement, retreat, disband and a new build", () => {
    const game = new Game();
    const history: Record[] = [];
    play(game, { ITALY: ["A VEN - TYR", "A ROM - VEN"] }, history);
    play(game, { ITALY: ["A VEN - TRI", "A TYR S A VEN - TRI"] }, history);
    expect(game.phase()).toBe("F1901R");
    const dislodged = trackUnits(history, game.state());
    const start = dislodged.phases[0]!;
    const fleet = start[unitKey("AUSTRIA", "F TRI")]!;
    const rome = start[unitKey("ITALY", "A ROM")]!;
    // The fleet is knocked out of Trieste but is still the same piece; the army that took it came from Rome.
    expect(dislodged.live[unitKey("AUSTRIA", "*F TRI")]).toBe(fleet);
    expect(dislodged.live[unitKey("ITALY", "A TRI")]).toBe(rome);

    play(game, { AUSTRIA: ["F TRI R ALB"] }, history);
    expect(game.phase()).toBe("W1901A");
    const retreated = trackUnits(history, game.state());
    expect(retreated.live[unitKey("AUSTRIA", "F ALB")]).toBe(fleet);

    play(game, { ITALY: ["A ROM B"], AUSTRIA: ["F ALB D"] }, history);
    const adjusted = trackUnits(history, game.state());
    // The disbanded fleet's id is gone for good and the new army has an id nothing ever had.
    expect(Object.values(adjusted.live)).not.toContain(fleet);
    const built = adjusted.live[unitKey("ITALY", "A ROM")]!;
    expect(built).toBeDefined();
    for (const ids of adjusted.phases) expect(Object.values(ids)).not.toContain(built);
    expect(adjusted.live[unitKey("ITALY", "A TRI")]).toBe(rome);
    expect(new Set(Object.values(adjusted.live)).size).toBe(Object.keys(adjusted.live).length);
  });

  it("is deterministic, so an undo or a reload keeps every id", () => {
    const run = () => {
      const game = new Game();
      const history: Record[] = [];
      play(game, { ENGLAND: ["F LON - NTH", "A LVP - YOR"] }, history);
      play(game, { ENGLAND: ["A YOR - NWY VIA", "F NTH C A YOR - NWY"] }, history);
      return { history, tracked: trackUnits(history, game.state()) };
    };
    const a = run();
    const b = run();
    expect(a.tracked).toEqual(b.tracked);
    // The army convoyed to Norway is the one that started in Liverpool.
    expect(a.tracked.live[unitKey("ENGLAND", "A NWY")]).toBe(a.tracked.phases[0]![unitKey("ENGLAND", "A LVP")]);
    // Undoing the last phase is the same as tracking the shorter history.
    const undone = trackUnits(a.history.slice(0, 1), a.history[1]!.state);
    expect(undone.live).toEqual(a.tracked.phases[1]);
  });
});

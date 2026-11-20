import type { SeatView } from "@cabal/protocol";
import { describe, expect, it } from "vitest";
import { readiness, seatState } from "./seatState.js";

const seat = (over: Partial<SeatView> = {}): SeatView => ({
  power: "FRANCE",
  kind: "human",
  name: "Ada",
  ready: false,
  eliminated: false,
  missed: 0,
  brain: null,
  present: true,
  submitted: false,
  canAct: true,
  host: false,
  ...over,
});

describe("what a seat is doing", () => {
  it("says each state in a word and in a sentence", () => {
    expect(seatState(seat(), true)).toMatchObject({ word: "Writing", tone: "waiting" });
    expect(seatState(seat({ submitted: true }), true)).toMatchObject({ word: "Filed", sentence: "France, Ada: orders in, not ready yet." });
    expect(seatState(seat({ submitted: true, ready: true }), true)).toMatchObject({ word: "Ready", tone: "ready" });
    expect(seatState(seat({ present: false }), true)).toMatchObject({ word: "Away", tone: "away" });
    expect(seatState(seat({ canAct: false }), true).word).toBe("Rests");
    expect(seatState(seat({ kind: "ai", brain: "claude", name: "Automaton" }), true)).toMatchObject({ word: "Claude", tone: "machine" });
    expect(seatState(seat({ kind: "civil_disorder", autopilot: true }), true)).toMatchObject({ word: "Bot", tone: "disorder" });
    expect(seatState(seat({ kind: "civil_disorder", autopilot: true, brain: "bot" }), true)).toMatchObject({ word: "Bot", tone: "disorder" });
    expect(seatState(seat({ kind: "civil_disorder", autopilot: true, brain: "claude" }), true)).toMatchObject({
      word: "Claude",
      tone: "disorder",
      sentence: "France: Ada missed turns; Claude is playing the seat until they return.",
    });
    expect(seatState(seat({ kind: "civil_disorder" }), true).word).toBe("C. D.");
    expect(seatState(seat({ eliminated: true }), true).sentence).toBe("France: out of the game, Ada watching as a ghost.");
    expect(seatState(seat({ kind: "open", name: null }), false).word).toBe("Open");
    expect(seatState(seat(), false, 0.25)).toMatchObject({ word: "25%", tone: "ready" });
  });

  it("counts only the seats that must act toward ready", () => {
    const seats = [seat({ ready: true }), seat({ power: "ITALY" }), seat({ power: "TURKEY", canAct: false }), seat({ power: "RUSSIA", kind: "civil_disorder" })];
    expect(readiness(seats)).toEqual({ ready: 1, acting: 2 });
  });
});

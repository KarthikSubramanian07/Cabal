import { type SeatView, resolveSettings } from "@cabal/protocol";
import { describe, expect, it } from "vitest";
import { POWERS } from "../lobby/terms.js";
import { canVote, myBallot, proposalLine, shareLine, tallyLine, voiceless } from "./votes.js";

const seat = (power: string, over: Partial<SeatView> = {}): SeatView => ({
  power: power as SeatView["power"],
  kind: "ai",
  name: null,
  ready: false,
  eliminated: false,
  missed: 0,
  brain: "bot",
  present: true,
  submitted: false,
  canAct: true,
  host: false,
  ...over,
});

describe("the draw vote", () => {
  const votes = { phase: "S1902M", draw: [{ power: "FRANCE" as const, value: true, include: null }], required: ["FRANCE", "ITALY"] as ("FRANCE" | "ITALY")[], hidden: false, cast: 1, yes: 1 };

  it("reads the tally the way the server counts it", () => {
    expect(tallyLine(null)).toBe("Nobody at the table has a vote right now.");
    expect(tallyLine({ ...votes, draw: [], cast: 0, yes: 0 })).toBe("No votes yet. A draw needs all 2 players at the table.");
    expect(tallyLine(votes)).toBe("1 of 2 for a draw. It passes when both say yes.");
    expect(tallyLine({ ...votes, required: ["FRANCE", "ITALY", "TURKEY"], cast: 2 })).toBe("1 of 3 for a draw, 1 against. It passes when all 3 say yes.");
  });

  it("lets humans vote, and ghosts only when the game allows it", () => {
    const s = resolveSettings({ ghostVotes: false });
    expect(canVote(seat("FRANCE", { kind: "human" }), s)).toBe(true);
    expect(canVote(seat("FRANCE"), s)).toBe(false);
    expect(canVote(seat("FRANCE", { kind: "human", eliminated: true }), s)).toBe(false);
    expect(canVote(seat("FRANCE", { kind: "human", eliminated: true }), { ...s, ghostVotes: true })).toBe(true);
  });

  it("always includes a survivor who has no vote", () => {
    const seats = POWERS.map((p) => seat(p, { kind: p === "FRANCE" || p === "ITALY" ? "human" : "ai", eliminated: p === "TURKEY" }));
    expect(voiceless(seats, votes)).toEqual(["AUSTRIA", "ENGLAND", "GERMANY", "RUSSIA"]);
  });

  it("finds the viewer's own ballot and says proposals and shares in words", () => {
    expect(myBallot(votes, "FRANCE")).toEqual({ value: true, include: null });
    expect(myBallot(votes, "ITALY")).toBeNull();
    expect(proposalLine(null)).toBe("everyone still on the board");
    expect(proposalLine(["ENGLAND", "FRANCE", "ITALY"])).toBe("England, France and Italy");
    expect(shareLine(resolveSettings({ dias: true, scoring: "dss" }))).toBe("Every survivor shares the draw, in equal shares.");
  });
});

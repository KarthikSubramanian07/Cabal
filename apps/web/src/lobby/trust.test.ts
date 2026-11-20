import type { TrustView } from "@cabal/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetTrust, lookUpTrust, trustFigure, trustNote, trustSentence } from "./trust.js";

const t = (kept: number, broken: number, score = (kept + 5) / (kept + broken + 10)): TrustView => ({ score, kept, broken, void: 0 });

describe("trust on a seat", () => {
  it("is a percentage and the promises it stands on", () => {
    expect(trustFigure(t(5, 1))).toBe("63%");
    expect(trustNote(t(5, 1))).toBe("5 of 6 kept");
    expect(trustSentence(t(0, 0))).toBe("Trust 50%, no promises yet.");
  });
});

describe("looking a player up", () => {
  beforeEach(forgetTrust);

  it("asks once per player per visit, whatever the handle's case", async () => {
    const fetch = vi.fn(async () => t(1, 0));
    await Promise.all([lookUpTrust("Ada", fetch), lookUpTrust("ada", fetch), lookUpTrust("ADA", fetch)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failed look-up instead of remembering the failure", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(t(2, 1));
    expect(await lookUpTrust("Bea", fetch)).toBeNull();
    expect(await lookUpTrust("Bea", fetch)).toEqual(t(2, 1));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

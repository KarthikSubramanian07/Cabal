import type { TrustView } from "@cabal/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRUST_STALE_MS, forgetTrust, lookUpTrust, trustFigure, trustNote, trustSentence } from "./trust.js";

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
    await Promise.all([lookUpTrust("Ada", { fetch }), lookUpTrust("ada", { fetch }), lookUpTrust("ADA", { fetch })]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failed look-up instead of remembering the failure", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(t(2, 1));
    expect(await lookUpTrust("Bea", { fetch })).toBeNull();
    expect(await lookUpTrust("Bea", { fetch })).toEqual(t(2, 1));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("looking again when trust may have moved", () => {
  beforeEach(forgetTrust);

  it("keeps a figure younger than the staleness window, and fetches an older one again", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(t(1, 0)).mockResolvedValueOnce(t(2, 0));
    expect(await lookUpTrust("Cy", { fetch, now: 0 })).toEqual(t(1, 0));
    // A phase turns half a minute later: the figure is young enough to stand.
    expect(await lookUpTrust("Cy", { fetch, now: TRUST_STALE_MS / 2, maxAge: TRUST_STALE_MS })).toEqual(t(1, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    // Another turn past the window: looked at again, and the new figure is the one kept.
    expect(await lookUpTrust("Cy", { fetch, now: TRUST_STALE_MS + 1, maxAge: TRUST_STALE_MS })).toEqual(t(2, 0));
    expect(await lookUpTrust("Cy", { fetch, now: TRUST_STALE_MS + 2 })).toEqual(t(2, 0));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("asks past the browser's cache when the game has just ended, however young the figure", async () => {
    const fetch = vi.fn(async () => t(3, 1));
    await lookUpTrust("Di", { fetch, now: 0 });
    await lookUpTrust("Di", { fetch, now: 1, maxAge: 0, fresh: true });
    expect(fetch.mock.calls).toEqual([
      ["Di", false],
      ["Di", true],
    ]);
  });

  it("keeps the figure it had when a look-up again fails, and tries once more next time", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(t(4, 0)).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(t(4, 1));
    await lookUpTrust("Ed", { fetch, now: 0 });
    expect(await lookUpTrust("Ed", { fetch, now: TRUST_STALE_MS + 1, maxAge: TRUST_STALE_MS })).toEqual(t(4, 0));
    expect(await lookUpTrust("Ed", { fetch, now: TRUST_STALE_MS + 2, maxAge: TRUST_STALE_MS })).toEqual(t(4, 1));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("shares one look-up again between every seat that asks at the same moment", async () => {
    const fetch = vi.fn(async () => t(1, 1));
    await lookUpTrust("Fay", { fetch, now: 0 });
    await Promise.all([1, 2, 3].map(() => lookUpTrust("fay", { fetch, now: TRUST_STALE_MS + 5, maxAge: TRUST_STALE_MS })));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

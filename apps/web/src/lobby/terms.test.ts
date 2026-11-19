import { ApiError } from "@cabal/protocol/client";
import { resolveSettings } from "@cabal/protocol";
import { describe, expect, it } from "vitest";
import { failureText, socketUrl } from "../net/api.js";
import { ago, describeTerms, duration, phaseLabel, powerLabel, shortTerms, timeLeft } from "./terms.js";

describe("terms of a table", () => {
  it("says durations the way people do", () => {
    expect(duration(600)).toBe("10 minutes");
    expect(duration(60)).toBe("1 minute");
    expect(duration(86_400)).toBe("1 day");
    expect(duration(172_800)).toBe("2 days");
    expect(duration(43_200)).toBe("12 hours");
    expect(duration(5_400)).toBe("90 minutes");
    expect(duration(45)).toBe("45 seconds");
  });

  it("describes every setting a lobby chooses", () => {
    const terms = describeTerms(resolveSettings({ pacing: "live", press: "gunboat", dias: false, scoring: "dss", visibility: "public" }));
    expect(terms).toEqual([
      { name: "Pacing", value: "Live, 10 minutes to move" },
      { name: "Press", value: "Gunboat" },
      { name: "Rules", value: "2023 rules" },
      { name: "Draws", value: "May name who shares" },
      { name: "Scoring", value: "Draw size" },
      { name: "Empty seats", value: "Played by the bot when the game starts" },
      { name: "Listing", value: "Listed in the games room" },
    ]);
    expect(describeTerms(resolveSettings({ aiBrain: "claude" }), true).find((t) => t.name === "Empty seats")?.value).toBe("Played by Claude");
    expect(describeTerms(resolveSettings({ aiFill: false })).find((t) => t.name === "Empty seats")?.value).toBe("Wait for players");
    expect(shortTerms(resolveSettings({ pacing: "daily", rulebook: "1982" }))).toBe("Daily, full press, 1982 rules");
  });

  it("names powers and phases in words", () => {
    expect(powerLabel("AUSTRIA")).toBe("Austria");
    expect(phaseLabel("S1901M")).toBe("Spring 1901, movement");
    expect(phaseLabel("F1903R")).toBe("Autumn 1903, retreats");
    expect(phaseLabel("W1901A")).toBe("Winter 1901, adjustments");
    expect(phaseLabel("COMPLETED")).toBe("Game over");
  });

  it("says how long is left and how long ago", () => {
    const now = 1_000_000_000;
    expect(timeLeft(now - 1, now)).toBe("due now");
    expect(timeLeft(now + 4 * 60_000, now)).toBe("4 min");
    expect(timeLeft(now + 200 * 60_000, now)).toBe("3 h 20 min");
    expect(timeLeft(now + 3 * 3_600_000, now)).toBe("3 h");
    expect(timeLeft(now + 72 * 3_600_000, now)).toBe("3 days");
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
});

describe("talking to the server", () => {
  it("opens the socket on this origin, upgraded to wss on https", () => {
    expect(socketUrl("K7Q2XZ", { protocol: "https:", host: "playcabal.pages.dev" })).toBe("wss://playcabal.pages.dev/api/games/K7Q2XZ/ws");
    expect(socketUrl("K7Q2XZ", { protocol: "http:", host: "localhost:4173" })).toBe("ws://localhost:4173/api/games/K7Q2XZ/ws");
  });

  it("turns failures into sentences a player can act on", () => {
    expect(failureText(new ApiError(409, "no open seats", null))).toBe("No open seats.");
    expect(failureText(new ApiError(429, "too many requests", null))).toContain("Too many tries");
    expect(failureText(new ApiError(503, "game server unavailable", null))).toContain("could not answer");
    expect(failureText(new TypeError("Failed to fetch"))).toContain("cannot be reached");
  });
});

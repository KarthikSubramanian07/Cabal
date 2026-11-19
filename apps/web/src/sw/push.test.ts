import { describe, expect, it } from "vitest";
import { clickTarget, fallbackNotification, notificationFor, pickClient } from "./push.js";

const ORIGIN = "https://playcabal.pages.dev";

describe("push messages", () => {
  it("are shown with their title, body and tag, and open their game on a click", () => {
    const shown = notificationFor({ kind: "deadline", gameId: "K7Q2XZ", title: "Orders due in 30 minutes", body: "Table K7Q 2XZ", url: "/g/K7Q2XZ", tag: "K7Q2XZ:deadline", sentAt: 5 }, ORIGIN);
    expect(shown?.title).toBe("Orders due in 30 minutes");
    expect(shown?.options.tag).toBe("K7Q2XZ:deadline");
    expect(shown?.options.data.url).toBe("/g/K7Q2XZ");
    expect(shown?.options.timestamp).toBe(5);
  });

  it("are dropped when they are not one of the server's", () => {
    for (const data of [null, "text", {}, { kind: "spam", title: "x", body: "y" }, { kind: "phase", title: 1, body: "y" }]) expect(notificationFor(data, ORIGIN)).toBeNull();
  });

  it("never send a click to another site", () => {
    expect(clickTarget("https://evil.example/phish", ORIGIN)).toBe("/");
    expect(clickTarget("javascript:alert(1)", ORIGIN)).toBe("/");
    expect(clickTarget("/replay/K7Q2XZ?at=3", ORIGIN)).toBe("/replay/K7Q2XZ?at=3");
    expect(clickTarget(undefined, ORIGIN)).toBe("/");
  });

  it("bring forward the window already on that page, else any of this site's", () => {
    const a = { url: `${ORIGIN}/games` };
    const b = { url: `${ORIGIN}/g/K7Q2XZ` };
    expect(pickClient([a, b], "/g/K7Q2XZ", ORIGIN)).toEqual({ client: b, navigate: false });
    expect(pickClient([a], "/g/K7Q2XZ", ORIGIN)).toEqual({ client: a, navigate: true });
    expect(pickClient([], "/g/K7Q2XZ", ORIGIN)).toBeNull();
  });
});

describe("a push this worker cannot read", () => {
  it("still says something of its own, pointing at the games room, rather than the browser's generic notice", () => {
    expect(notificationFor({ kind: "mystery" }, ORIGIN)).toBeNull();
    const shown = fallbackNotification();
    expect(shown.title).toBe("Something happened at your table");
    expect(shown.options.data.url).toBe("/games");
    expect(shown.options.tag).toBe("cabal-unknown");
  });
});

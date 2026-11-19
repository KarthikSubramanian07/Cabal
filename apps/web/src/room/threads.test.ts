import { type PressView, resolveSettings } from "@cabal/protocol";
import { describe, expect, it } from "vitest";
import { pressOpen, threadLabel, threadList, threadOf, totalUnread, whispersLeft } from "./threads.js";

let n = 0;
const msg = (from: string, to: string, phase = "S1901M"): PressView => ({ id: `m${++n}`, phase, from, to, body: "x", sentAt: n, pledge: null }) as PressView;

describe("threads", () => {
  it("files each message under the other power, or the table", () => {
    expect(threadOf(msg("FRANCE", "ITALY"), "ITALY")).toBe("FRANCE");
    expect(threadOf(msg("ITALY", "FRANCE"), "ITALY")).toBe("FRANCE");
    expect(threadOf(msg("ITALY", "ALL"), "ITALY")).toBe("ALL");
  });

  it("lists the table first, then the six other powers, with their unread counts", () => {
    const press = [msg("FRANCE", "ALL"), msg("FRANCE", "ITALY"), msg("ITALY", "FRANCE"), msg("TURKEY", "ITALY")];
    const threads = threadList(press, "ITALY", resolveSettings({ press: "full" }), { FRANCE: 2, ALL: 1 });
    expect(threads.map((t) => t.id)).toEqual(["ALL", "AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "RUSSIA", "TURKEY"]);
    expect(threads.find((t) => t.id === "FRANCE")!.messages).toHaveLength(2);
    expect(totalUnread(threads)).toBe(3);
  });

  it("gives spectators and public-press games the table alone", () => {
    expect(threadList([], null, resolveSettings({}), {}).map((t) => t.id)).toEqual(["ALL"]);
    expect(threadList([], "ITALY", resolveSettings({ press: "public" }), {}).map((t) => t.id)).toEqual(["ALL"]);
  });

  it("counts this phase's private messages against the whisper budget", () => {
    const press = [msg("ITALY", "FRANCE"), msg("ITALY", "ALL"), msg("ITALY", "TURKEY"), msg("ITALY", "FRANCE", "W1900A")];
    expect(whispersLeft(press, "ITALY", "S1901M", 3)).toBe(1);
    expect(whispersLeft(press, "ITALY", "S1901M", 2)).toBe(0);
    expect(whispersLeft(press, "ITALY", "S1901M", null)).toBeNull();
  });

  it("says why press is closed, in the composer's words", () => {
    const s = resolveSettings({});
    expect(pressOpen(s, "active", "S1901M", "FRANCE").open).toBe(true);
    expect(pressOpen({ ...s, press: "gunboat" }, "active", "S1901M", "ALL").why).toMatch(/Gunboat/);
    expect(pressOpen({ ...s, press: "public" }, "active", "S1901M", "FRANCE").open).toBe(false);
    expect(pressOpen({ ...s, rulebookPress: true }, "active", "F1901R", "ALL").why).toMatch(/retreats/);
    expect(pressOpen(s, "lobby", "S1901M", "FRANCE").open).toBe(false);
    expect(pressOpen(s, "finished", "S1901M", "ALL").open).toBe(false);
    expect(threadLabel("ALL")).toBe("The table");
    expect(threadLabel("FRANCE")).toBe("France");
  });
});

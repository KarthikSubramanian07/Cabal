import { describe, expect, it } from "vitest";
import { DRAFT_TTL_MS, type Draft, clearDraft, decodeDraft, draftKey, forgetDrafts, readDraft, sweepDrafts, writeDraft } from "./drafts.js";

/** localStorage, in memory. */
function memory(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}

/** Storage that refuses everything, as a blocked private window does. */
const refusing: Storage = {
  length: 0,
  key: () => {
    throw new Error("SecurityError");
  },
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
  clear: () => undefined,
};

const NOW = Date.UTC(2026, 10, 19, 12);
const draft = (over: Partial<Draft> = {}): Draft => ({
  gameId: "K7Q2XZ",
  power: "FRANCE",
  phase: "S1901M",
  book: { "A PAR": "A PAR - BUR", "F BRE": "F BRE - MAO" },
  savedAt: NOW,
  ...over,
});

describe("drafts on this device", () => {
  it("keeps a seat's unsent orders for its phase and gives them back", () => {
    const store = memory();
    expect(writeDraft(draft(), store)).toBe(true);
    expect(readDraft("K7Q2XZ", "FRANCE", "S1901M", store)).toEqual(draft());
  });

  it("keeps one draft per game and per seat", () => {
    const store = memory();
    writeDraft(draft(), store);
    writeDraft(draft({ power: "GERMANY", book: { "A MUN": "A MUN - BUR" } }), store);
    writeDraft(draft({ gameId: "M3PQ7R", book: { "A MAR": "A MAR H" } }), store);
    expect(readDraft("K7Q2XZ", "FRANCE", "S1901M", store)?.book).toEqual(draft().book);
    expect(readDraft("K7Q2XZ", "GERMANY", "S1901M", store)?.book).toEqual({ "A MUN": "A MUN - BUR" });
    expect(readDraft("M3PQ7R", "FRANCE", "S1901M", store)?.book).toEqual({ "A MAR": "A MAR H" });
  });

  it("drops a draft once its phase is over", () => {
    const store = memory();
    writeDraft(draft(), store);
    expect(readDraft("K7Q2XZ", "FRANCE", "F1901M", store)).toBeNull();
    expect(store.getItem(draftKey("K7Q2XZ", "FRANCE"))).toBeNull();
  });

  it("clears a draft the server has acknowledged", () => {
    const store = memory();
    writeDraft(draft(), store);
    clearDraft("K7Q2XZ", "FRANCE", store);
    expect(readDraft("K7Q2XZ", "FRANCE", "S1901M", store)).toBeNull();
  });

  it("forgets every draft of a game the device lets go of, and only that game's", () => {
    const store = memory();
    writeDraft(draft(), store);
    writeDraft(draft({ power: "GERMANY" }), store);
    writeDraft(draft({ gameId: "K7Q2XY" }), store);
    forgetDrafts("K7Q2XZ", store);
    expect(readDraft("K7Q2XZ", "FRANCE", "S1901M", store)).toBeNull();
    expect(readDraft("K7Q2XZ", "GERMANY", "S1901M", store)).toBeNull();
    expect(readDraft("K7Q2XY", "FRANCE", "S1901M", store)).not.toBeNull();
  });

  it("sweeps drafts of games long gone when another is written", () => {
    const store = memory();
    writeDraft(draft({ gameId: "OLD222", savedAt: NOW - DRAFT_TTL_MS - 1 }), store);
    store.setItem(draftKey("BAD333", "FRANCE"), "{not json");
    writeDraft(draft(), store);
    expect(store.getItem(draftKey("OLD222", "FRANCE"))).toBeNull();
    expect(store.getItem(draftKey("BAD333", "FRANCE"))).toBeNull();
    expect(store.getItem(draftKey("K7Q2XZ", "FRANCE"))).not.toBeNull();
    sweepDrafts(NOW + DRAFT_TTL_MS + 1, store);
    expect(store.length).toBe(0);
  });

  it("reads anything damaged, or of another shape, as no draft", () => {
    expect(decodeDraft(null)).toBeNull();
    expect(decodeDraft("{")).toBeNull();
    expect(decodeDraft(JSON.stringify({ ...draft(), v: 2 }))).toBeNull();
    expect(decodeDraft(JSON.stringify({ ...draft(), v: 1, book: ["A PAR H"] }))).toBeNull();
    expect(decodeDraft(JSON.stringify({ ...draft(), v: 1, book: { "A PAR": 3 } }))).toBeNull();
    expect(decodeDraft(JSON.stringify({ ...draft(), v: 1, savedAt: "today" }))).toBeNull();
    const store = memory();
    // A draft copied under another seat's key is not that seat's.
    store.setItem(draftKey("K7Q2XZ", "ITALY"), JSON.stringify({ v: 1, ...draft() }));
    expect(readDraft("K7Q2XZ", "ITALY", "S1901M", store)).toBeNull();
  });

  it("never throws when storage is blocked or full", () => {
    expect(writeDraft(draft(), refusing)).toBe(false);
    expect(readDraft("K7Q2XZ", "FRANCE", "S1901M", refusing)).toBeNull();
    expect(() => clearDraft("K7Q2XZ", "FRANCE", refusing)).not.toThrow();
    expect(() => forgetDrafts("K7Q2XZ", refusing)).not.toThrow();
    expect(() => sweepDrafts(NOW, refusing)).not.toThrow();
    expect(writeDraft(draft(), null)).toBe(false);
    expect(readDraft("K7Q2XZ", "FRANCE", "S1901M", null)).toBeNull();
  });
});

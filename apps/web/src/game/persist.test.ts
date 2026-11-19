import { describe, expect, it } from "vitest";
import {
  ImportError,
  SAVE_KEY,
  SAVE_SCHEMA,
  clearSave,
  decodeSave,
  encodeSave,
  parseSavedGame,
  readSave,
  writeSave,
} from "./persist.js";

const save = {
  savedAt: 1_800_000_000_000,
  game: '{"phases":[{"name":"S1901M"}]}',
  written: [{ FRANCE: { "A PAR": "A PAR - BUR" } }, {}],
  orders: { FRANCE: { "A PAR": "A PAR - BUR" } },
  active: "FRANCE",
};

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("sandbox save", () => {
  it("round trips with its schema number", () => {
    const raw = encodeSave(save);
    expect(JSON.parse(raw).schema).toBe(SAVE_SCHEMA);
    expect(decodeSave(raw)).toEqual({ schema: SAVE_SCHEMA, ...save });
  });

  it("ignores a save from another schema instead of half-loading it", () => {
    expect(decodeSave(JSON.stringify({ ...save, schema: SAVE_SCHEMA + 1 }))).toBeNull();
    expect(decodeSave(JSON.stringify({ ...save, schema: 0 }))).toBeNull();
    expect(decodeSave(JSON.stringify(save))).toBeNull();
  });

  it("ignores anything malformed", () => {
    for (const raw of [
      null,
      "",
      "{",
      "null",
      "[]",
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, game: "" }),
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, game: 7 }),
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, savedAt: "yesterday" }),
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, orders: [] }),
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, orders: { FRANCE: { "A PAR": 1 } } }),
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, orders: { FRANCE: ["A PAR - BUR"] } }),
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, active: null }),
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, written: undefined }),
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, written: {} }),
      JSON.stringify({ schema: SAVE_SCHEMA, ...save, written: [{ FRANCE: ["A PAR - BUR"] }] }),
    ]) {
      expect(decodeSave(raw), String(raw)).toBeNull();
    }
  });

  it("keeps what was written in each resolved phase", () => {
    expect(decodeSave(encodeSave(save))?.written).toEqual(save.written);
  });

  it("still reads a schema 1 save, which has no record of what was written", () => {
    const { written: _written, ...old } = save;
    expect(decodeSave(JSON.stringify({ schema: 1, ...old }))).toEqual({ schema: SAVE_SCHEMA, ...save, written: [] });
  });

  it("does not open a power that does not exist", () => {
    expect(decodeSave(encodeSave({ ...save, active: "ATLANTIS" }))?.active).toBe("FRANCE");
    expect(decodeSave(encodeSave({ ...save, active: "RUSSIA" }))?.active).toBe("RUSSIA");
  });

  it("writes, reads and clears through storage", () => {
    const storage = memory();
    expect(readSave(storage)).toBeNull();
    expect(writeSave(save, storage)).toBe(true);
    expect(storage.data.has(SAVE_KEY)).toBe(true);
    expect(readSave(storage)?.orders).toEqual(save.orders);
    clearSave(storage);
    expect(readSave(storage)).toBeNull();
  });

  it("survives storage that throws or is missing", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readSave(broken)).toBeNull();
    expect(writeSave(save, broken)).toBe(false);
    expect(() => clearSave(broken)).not.toThrow();
    expect(writeSave(save, null)).toBe(false);
  });
});

describe("parseSavedGame", () => {
  const message = (text: string) => {
    try {
      parseSavedGame(text);
    } catch (err) {
      expect(err).toBeInstanceOf(ImportError);
      return err as ImportError;
    }
    throw new Error("expected a rejection");
  };

  it("accepts a saved game", () => {
    const file = parseSavedGame(JSON.stringify({ phases: [{ name: "S1901M", state: {}, orders: {} }] }));
    expect(file.phases).toHaveLength(1);
  });

  it("explains a file that is not JSON without quoting the parser", () => {
    const err = message("{ not json");
    expect(err.message).toBe("That file is not a Cabal game export. It is not JSON.");
    expect(err.message).not.toMatch(/position|line|column|Expected/);
    expect(err.detail.length).toBeGreaterThan(0);
  });

  it("explains JSON that is not a saved game", () => {
    expect(message("{}").message).toContain("no phases");
    expect(message("[]").message).toContain("no phases");
    expect(message("null").message).toContain("no phases");
    expect(message('{"phases":[]}').message).toContain("no phases");
    expect(message('{"phases":[{"name":"S1901M"}]}').message).toContain("incomplete");
  });
});

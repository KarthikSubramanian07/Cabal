import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSeat, forgetSeatsOf, listSeats, readName, readSeat, saveName, saveSeat } from "./seats.js";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const TOKEN = "K7Q2XZ.FRANCE.560d56d2c705ef7fd3a216b717c04e237b30ffaf3d4d2cf8";

describe("seats kept on this device", () => {
  let store: MemoryStorage;
  beforeEach(() => {
    store = new MemoryStorage();
    vi.stubGlobal("localStorage", store);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a seat per game and reads it back", () => {
    expect(saveSeat({ gameId: "K7Q2XZ", power: "FRANCE", token: TOKEN, name: "Ada", savedAt: 5 })).toBe(true);
    expect(readSeat("K7Q2XZ")).toEqual({ gameId: "K7Q2XZ", power: "FRANCE", token: TOKEN, name: "Ada", userId: null, savedAt: 5 });
    expect(store.getItem("cabal.seat.K7Q2XZ")).toContain(TOKEN);
    expect(readSeat("ABCDEF")).toBeNull();
  });

  it("refuses a token that belongs to another game", () => {
    store.setItem("cabal.seat.ABCDEF", JSON.stringify({ power: "FRANCE", token: TOKEN, name: "Ada", savedAt: 1 }));
    expect(readSeat("ABCDEF")).toBeNull();
  });

  it("reads damaged entries as no seat", () => {
    store.setItem("cabal.seat.K7Q2XZ", "{not json");
    expect(readSeat("K7Q2XZ")).toBeNull();
    store.setItem("cabal.seat.K7Q2XZ", JSON.stringify({ power: "PRUSSIA", token: TOKEN }));
    expect(readSeat("K7Q2XZ")).toBeNull();
  });

  it("forgets the seats an account took when it leaves the device, and nobody else's", () => {
    const seat = (gameId: string, name: string, userId?: string) =>
      saveSeat({ gameId, power: "FRANCE", token: `${gameId}.FRANCE.${"a".repeat(48)}`, name, ...(userId ? { userId } : {}), savedAt: 1 });
    seat("AAAAAA", "ada_l", "pl_ada");
    // Taken under the handle before seats recorded their account.
    seat("BBBBBB", "Ada_L");
    // Another account on this device, and a seat taken without one.
    seat("CCCCCC", "bea", "pl_bea");
    seat("DDDDDD", "Guest");
    expect(forgetSeatsOf({ id: "pl_ada", handle: "ada_l" }).sort()).toEqual(["AAAAAA", "BBBBBB"]);
    expect(listSeats().map((s) => s.gameId).sort()).toEqual(["CCCCCC", "DDDDDD"]);
  });

  it("lists every seat held, newest first, and forgets one", () => {
    const other = "ABCDEF.ITALY.560d56d2c705ef7fd3a216b717c04e237b30ffaf3d4d2cf8";
    saveSeat({ gameId: "K7Q2XZ", power: "FRANCE", token: TOKEN, name: "Ada", savedAt: 1 });
    saveSeat({ gameId: "ABCDEF", power: "ITALY", token: other, name: "Ada", savedAt: 2 });
    store.setItem("cabal.shortcuts", "off");
    expect(listSeats().map((s) => s.gameId)).toEqual(["ABCDEF", "K7Q2XZ"]);
    forgetSeat("ABCDEF");
    expect(listSeats().map((s) => s.gameId)).toEqual(["K7Q2XZ"]);
  });

  it("remembers the name the player sat down under", () => {
    expect(readName()).toBe("");
    saveName("  Ada ");
    expect(readName()).toBe("Ada");
  });

  it("carries on when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
      key() {
        throw new Error("blocked");
      },
      length: 1,
    });
    expect(saveSeat({ gameId: "K7Q2XZ", power: "FRANCE", token: TOKEN, name: "Ada" })).toBe(false);
    expect(readSeat("K7Q2XZ")).toBeNull();
    expect(listSeats()).toEqual([]);
    expect(readName()).toBe("");
    expect(() => forgetSeat("K7Q2XZ")).not.toThrow();
  });
});

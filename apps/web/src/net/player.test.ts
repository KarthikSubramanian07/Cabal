import { beforeEach, describe, expect, it } from "vitest";
import { forgetPlayer, parsePlayer, readPlayer, recoveryFile, renameStoredPlayer, savePlayer, tidyRecoveryCode } from "./player.js";

class MemoryStorage {
  data = new Map<string, string>();
  refuse = false;
  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.refuse) throw new Error("QuotaExceededError");
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
}

const store = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
Object.defineProperty(globalThis, "window", { value: new EventTarget(), configurable: true });

describe("the player on this device", () => {
  beforeEach(() => {
    store.refuse = false;
    forgetPlayer();
  });

  it("keeps the account and reads the same object back until it changes", () => {
    expect(readPlayer()).toBeNull();
    expect(savePlayer({ id: "p1", handle: "ada", secret: "ps_x", savedAt: 5 })).toBe(true);
    const first = readPlayer();
    expect(first).toEqual({ id: "p1", handle: "ada", secret: "ps_x", savedAt: 5 });
    expect(readPlayer()).toBe(first);
    renameStoredPlayer("lovelace");
    expect(readPlayer()?.handle).toBe("lovelace");
    expect(readPlayer()?.secret).toBe("ps_x");
  });

  it("holds the account for the visit when storage refuses it", () => {
    store.refuse = true;
    expect(savePlayer({ id: "p1", handle: "ada", secret: "ps_x" })).toBe(false);
    expect(readPlayer()?.handle).toBe("ada");
    forgetPlayer();
    expect(readPlayer()).toBeNull();
  });

  it("ignores anything stored that is not a whole account", () => {
    for (const raw of ["", "nope", "null", "{}", '{"id":"p","handle":"a"}', '{"id":"p","handle":"a","secret":""}']) expect(parsePlayer(raw), raw).toBeNull();
  });
});

describe("recovery codes", () => {
  it("are sent without the spaces and breaks people copy them with", () => {
    expect(tidyRecoveryCode("  ABCD EFGH\n IJKL-MNOP ")).toBe("ABCDEFGHIJKL-MNOP");
  });

  it("are saved with the handle, the day and how to use them", () => {
    const text = recoveryFile("ada", "CODE-1234", Date.UTC(2026, 10, 19), "https://playcabal.pages.dev");
    expect(text).toContain("Handle: ada");
    expect(text).toContain("Issued: 2026-11-19");
    expect(text).toContain("CODE-1234");
    expect(text).toContain("Restore an account");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = { sync: vi.fn(), pushSync: vi.fn() };
vi.mock("./lazy.js", () => ({ loadApi: async () => ({ api }) }));

const { gameOf, localPrefs, noteSandboxSaved, onRemotePrefs, reconcile, savedAtOf, settleBeforeSignOut } = await import("./sync.js");
const { savePlayer, forgetPlayer } = await import("./player.js");

/** localStorage as a plain map, so the module reads and writes what the test sets. */
function fakeStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => undefined, removeEventListener: () => undefined });
  return map;
}

const save = (savedAt: number, game = "g") => JSON.stringify({ schema: 2, savedAt, game, written: [], orders: {}, active: "FRANCE" });
const player = { id: "p1", handle: "ada", secret: "ps_x", google: true };
const empty = { prefs: null, prefsAt: null, sandbox: null };

let store: Map<string, string>;
beforeEach(() => {
  store = fakeStorage();
  api.sync.mockReset();
  api.pushSync.mockReset().mockResolvedValue(empty);
  savePlayer(player);
});
afterEach(() => {
  forgetPlayer();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reading a save", () => {
  it("finds its time, and tells the same game saved again from a changed one", () => {
    expect(savedAtOf(save(42))).toBe(42);
    expect(savedAtOf("not json")).toBe(0);
    expect(gameOf(save(1, "a"))).toBe(gameOf(save(2, "a")));
    expect(gameOf(save(1, "a"))).not.toBe(gameOf(save(1, "b")));
  });
});

describe("bringing a device and the account level", () => {
  it("takes the account's settings when they changed after this device's", async () => {
    store.set("cabal.prefs.at", "100");
    const applied = vi.fn();
    onRemotePrefs(applied);
    api.sync.mockResolvedValue({ prefs: { shortcuts: false, sound: true }, prefsAt: 200, sandbox: null });
    await reconcile({ ...player, savedAt: 0 });
    expect(applied).toHaveBeenCalledWith({ shortcuts: false, sound: true });
    expect(localPrefs().at).toBe(200);
    expect(api.pushSync).not.toHaveBeenCalled();
  });

  it("sends this device's settings and game when they are newer", async () => {
    store.set("cabal.prefs.at", "300");
    store.set("cabal.shortcuts", "off");
    store.set("cabal.sandbox", save(500));
    api.sync.mockResolvedValue({ prefs: { shortcuts: true }, prefsAt: 200, sandbox: { savedAt: 400, body: save(400) } });
    await reconcile({ ...player, savedAt: 0 });
    expect(api.pushSync).toHaveBeenCalledWith("ps_x", {
      prefs: { at: 300, value: { shortcuts: false, sound: false } },
      sandbox: { savedAt: 500, body: save(500) },
    });
  });

  it("writes the account's newer game on this device", async () => {
    store.set("cabal.sandbox", save(100, "old"));
    api.sync.mockResolvedValue({ prefs: null, prefsAt: null, sandbox: { savedAt: 900, body: save(900, "new") } });
    await reconcile({ ...player, savedAt: 0 });
    expect(store.get("cabal.sandbox")).toBe(save(900, "new"));
  });
});

describe("sending the sandbox", () => {
  it("waits for changes to settle, and does not send the game the account already has", async () => {
    vi.useFakeTimers();
    api.sync.mockResolvedValue({ prefs: null, prefsAt: null, sandbox: { savedAt: 10, body: save(10, "same") } });
    await reconcile({ ...player, savedAt: 0 });
    noteSandboxSaved(save(20, "same"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.pushSync).not.toHaveBeenCalled();
    noteSandboxSaved(save(30, "moved"));
    noteSandboxSaved(save(31, "moved again"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.pushSync).toHaveBeenCalledTimes(1);
    expect(api.pushSync).toHaveBeenCalledWith("ps_x", { sandbox: { savedAt: 31, body: save(31, "moved again") } });
  });

  it("sends what is waiting before a Google account signs out, then takes the game off this device", async () => {
    store.set("cabal.sandbox", save(50, "mine"));
    noteSandboxSaved(save(50, "mine"));
    await settleBeforeSignOut({ ...player, savedAt: 0 });
    expect(api.pushSync).toHaveBeenCalledWith("ps_x", { sandbox: { savedAt: 50, body: save(50, "mine") } });
    expect(store.has("cabal.sandbox")).toBe(false);
  });

  it("leaves a guest's game on the device when it signs out", async () => {
    store.set("cabal.sandbox", save(50));
    await settleBeforeSignOut({ ...player, google: false, savedAt: 0 });
    expect(store.has("cabal.sandbox")).toBe(true);
  });
});

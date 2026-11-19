import { afterEach, describe, expect, it, vi } from "vitest";
import { type PushEnv, keyBytes, pushState, sameKey, subscribedFor, turnOnPush } from "./push.js";

const desktop: PushEnv = { hasServiceWorker: true, hasPushManager: true, permission: "default", standalone: false, ios: false };

describe("pushState", () => {
  it("offers push where the browser can do it, and says when it is on", () => {
    expect(pushState(desktop, false)).toBe("off");
    expect(pushState({ ...desktop, permission: "granted" }, true)).toBe("on");
    // Allowed once but not subscribed on this device (cleared site data): still off.
    expect(pushState({ ...desktop, permission: "granted" }, false)).toBe("off");
  });

  it("says when the person blocked it, or the browser cannot", () => {
    expect(pushState({ ...desktop, permission: "denied" }, false)).toBe("denied");
    expect(pushState({ ...desktop, hasPushManager: false }, false)).toBe("unsupported");
    expect(pushState({ ...desktop, permission: null }, false)).toBe("unsupported");
  });

  it("tells an iPhone in the browser to add Cabal to the Home Screen first", () => {
    expect(pushState({ ...desktop, ios: true, hasPushManager: false, permission: null }, false)).toBe("needs-install");
    expect(pushState({ ...desktop, ios: true, standalone: true }, false)).toBe("off");
  });
});

describe("keyBytes", () => {
  it("decodes the server's base64url key", () => {
    expect([...keyBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
});

describe("a subscription made under a rotated server key", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is replaced, not registered again", async () => {
    const OLD = new Uint8Array([4, 1, 1, 1]).buffer;
    const NEW_KEY = "BAICAg"; // base64url of [4, 2, 2, 2]
    let unsubscribed = 0;
    let subscribedWith: Uint8Array | null = null;
    const sub = (endpoint: string, key: ArrayBuffer) => ({
      endpoint,
      options: { applicationServerKey: key, userVisibleOnly: true },
      toJSON: () => ({ endpoint, keys: { p256dh: "x", auth: "y" } }),
      unsubscribe: async () => {
        unsubscribed++;
        return true;
      },
    });
    const pushManager = {
      getSubscription: async () => sub("https://push.example/old", OLD),
      subscribe: async (o: { applicationServerKey: Uint8Array }) => {
        subscribedWith = o.applicationServerKey;
        return sub("https://push.example/new", o.applicationServerKey.buffer as ArrayBuffer);
      },
    };
    vi.stubGlobal("Notification", { requestPermission: async () => "granted" });
    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ pushManager }) } });
    const registered: string[] = [];
    const result = await turnOnPush({
      publicKey: async () => NEW_KEY,
      register: async (s) => {
        registered.push(String(s.endpoint));
        return { devices: 1 };
      },
    });
    expect(result).toEqual({ ok: true, devices: 1, endpoint: "https://push.example/new" });
    expect(registered).toEqual(["https://push.example/new"]);
    expect(unsubscribed).toBe(1);
    expect(subscribedWith && [...subscribedWith]).toEqual([4, 2, 2, 2]);
  });

  it("compares keys byte for byte, and trusts a browser that does not say", () => {
    expect(sameKey(new Uint8Array([4, 2]).buffer, new Uint8Array([4, 2]))).toBe(true);
    expect(sameKey(new Uint8Array([4, 1]).buffer, new Uint8Array([4, 2]))).toBe(false);
    expect(sameKey(null, new Uint8Array([4, 2]))).toBe(true);
  });
});

describe("subscribedFor: on for this account only", () => {
  it("needs the browser's subscription to be the one this account registered", () => {
    const owner = { playerId: "pl_ada", endpoint: "https://push.example/a" };
    expect(subscribedFor("pl_ada", "https://push.example/a", owner)).toBe(true);
    // Left by the account that signed out before this one signed in.
    expect(subscribedFor("pl_bea", "https://push.example/a", owner)).toBe(false);
    // The browser replaced its subscription since.
    expect(subscribedFor("pl_ada", "https://push.example/b", owner)).toBe(false);
    expect(subscribedFor("pl_ada", null, owner)).toBe(false);
    expect(subscribedFor("pl_ada", "https://push.example/a", null)).toBe(false);
  });
});

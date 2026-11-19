import { describe, expect, it } from "vitest";
import { type PushEnv, keyBytes, pushState } from "./push.js";

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

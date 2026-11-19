/** Every log line can be filtered on `service` and `requestId`, whoever wrote it and whatever it carries. */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver, notices, pushRuntime } from "../src/notify.js";
import { toBase64Url } from "../src/push.js";
import { log, withLogContext } from "../src/log.js";
import { create, newPlayer, nextIp, serverEnv } from "./helpers.js";
import { browserKeys, vapidKeys } from "./push-helpers.js";

type Line = Record<string, unknown> & { event: string };

async function capture<T>(work: () => Promise<T>): Promise<Line[]> {
  const lines: Line[] = [];
  const keep = (line: unknown) => {
    try {
      const parsed = JSON.parse(String(line)) as Line;
      if (parsed && typeof parsed.event === "string") lines.push(parsed);
    } catch {
      // not a structured line
    }
  };
  const info = vi.spyOn(console, "info").mockImplementation(keep);
  const error = vi.spyOn(console, "error").mockImplementation(keep);
  try {
    await work();
    return lines;
  } finally {
    info.mockRestore();
    error.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

// First in this file: the engine is instantiated once per isolate, by the first room to wake.
describe("lines written while a room wakes", () => {
  it("carry the room's service and a request id, the engine's cold start among them", async () => {
    const lines = await capture(() => create("Ann"));
    const ready = lines.find((l) => l.event === "engine_ready");
    expect(ready, "engine_ready was logged by this create").toBeDefined();
    expect(ready).toMatchObject({ service: "room" });
    expect(ready!.requestId).toMatch(/^wake-[0-9a-f]{16}$/);
  });
});

describe("fields a line carries", () => {
  it("never replace the line's own ts, level, event, service or requestId", async () => {
    const lines = await capture(async () =>
      withLogContext({ service: "room", requestId: "alarm-0000000000000001" }, () =>
        log("probe", { service: "fcm.googleapis.com", requestId: "forged", event: "other", level: "error", ts: "then", extra: 1 }),
      ),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "probe", level: "info", service: "room", requestId: "alarm-0000000000000001", extra: 1 });
    expect(lines[0]!.ts).not.toBe("then");
  });

  it("log a push the service refused as the room's, with the push service in its own field", async () => {
    const keys = await vapidKeys();
    const real = { ...pushRuntime };
    pushRuntime.keys = () => keys;
    pushRuntime.fetch = async () => new Response("nope", { status: 500 });
    try {
      const me = await newPlayer();
      const ua = await browserKeys();
      const sub = { endpoint: `https://fcm.googleapis.com/fcm/send/log-${Date.now()}`, expirationTime: null, keys: { p256dh: toBase64Url(ua.publicPoint), auth: toBase64Url(ua.auth) } };
      const res = await SELF.fetch("http://cabal/api/me/push", { method: "POST", headers: { "cf-connecting-ip": nextIp(), authorization: `Bearer ${me.secret}` }, body: JSON.stringify(sub) });
      expect(res.status).toBe(201);
      const lines = await capture(() =>
        withLogContext({ service: "room", requestId: "alarm-0000000000000002" }, () => deliver(serverEnv, [notices.started("ABCDEF", me.player.id, "FRANCE", "S1901M")])),
      );
      const rejected = lines.find((l) => l.event === "push_rejected");
      expect(rejected).toMatchObject({ service: "room", requestId: "alarm-0000000000000002", pushService: "fcm.googleapis.com", status: 500 });
    } finally {
      Object.assign(pushRuntime, real);
    }
  });
});

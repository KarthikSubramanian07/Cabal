/** Structured logs: one JSON line per event, each naming its service and the request behind it. */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { coldStart, timedFirst } from "../src/engine.js";
import { describeError, requestIdFrom } from "../src/log.js";
import type { AgentTurn } from "../src/env.js";
import { Client, create, deadlineIn, nextIp, serverEnv, start, untilPhase } from "./helpers.js";

type Line = Record<string, unknown> & { event: string };

/** Capture every log line written while `work` runs, parsed. */
async function capture<T>(work: () => Promise<T>): Promise<{ result: T; lines: Line[] }> {
  const lines: Line[] = [];
  const keep = (line: unknown) => {
    try {
      const parsed = JSON.parse(String(line)) as Line;
      if (parsed && typeof parsed.event === "string") lines.push(parsed);
    } catch {
      // not one of ours
    }
  };
  const info = vi.spyOn(console, "info").mockImplementation(keep);
  const error = vi.spyOn(console, "error").mockImplementation(keep);
  try {
    return { result: await work(), lines };
  } finally {
    info.mockRestore();
    error.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("request ids", () => {
  it("names every answer with its request id: Cloudflare's ray id when there is one, else a fresh one", async () => {
    const named = await SELF.fetch("http://cabal/api/games?status=open", { headers: { "cf-ray": "8f1e2d3c4b5a6978-LHR", "cf-connecting-ip": nextIp() } });
    expect(named.headers.get("x-request-id")).toBe("8f1e2d3c4b5a6978-LHR");
    expect(named.headers.get("access-control-expose-headers")).toContain("x-request-id");
    const fresh = await SELF.fetch("http://cabal/api/games?status=open", { headers: { "cf-connecting-ip": nextIp() } });
    expect(fresh.headers.get("x-request-id")).toMatch(/^req-[0-9a-f]{16}$/);
    // Anything odd in the header is replaced, never echoed or logged.
    expect(requestIdFrom("<script>")).toMatch(/^req-/);
    expect(requestIdFrom("a".repeat(65))).toMatch(/^req-/);
    expect(requestIdFrom("8f1e2d3c4b5a6978-LHR")).toBe("8f1e2d3c4b5a6978-LHR");
  });

  it("carries one id from the Worker into the room, on every line either writes", async () => {
    const { result, lines } = await capture(async () =>
      SELF.fetch("http://cabal/api/games", {
        method: "POST",
        headers: { "cf-ray": "ray-create-1", "cf-connecting-ip": nextIp() },
        body: JSON.stringify({ name: "Ann" }),
      }),
    );
    expect(result.status).toBe(200);
    const { gameId } = (await result.json()) as { gameId: string };
    const created = lines.find((l) => l.event === "game_created")!;
    expect(created).toMatchObject({ service: "room", requestId: "ray-create-1", gameId, level: "info" });
    expect(typeof created.ts).toBe("string");
    const access = lines.find((l) => l.event === "request")!;
    expect(access).toMatchObject({ service: "worker", requestId: "ray-create-1", route: "POST /api/games", status: 200 });
    expect(typeof access.ms).toBe("number");
    // Every line of this request carries its id, and none carries a secret.
    for (const line of lines.filter((l) => l.requestId === "ray-create-1")) expect(JSON.stringify(line)).not.toMatch(/token|secret/i);
  });

  it("logs a route as a label, never a path with a game code in it", async () => {
    const { lines } = await capture(async () => SELF.fetch("http://cabal/api/games/ZZZZZZ", { headers: { "cf-connecting-ip": nextIp() } }));
    expect(lines.find((l) => l.event === "request")).toMatchObject({ route: "GET /api/games/:id" });
  });

  it("logs a record's address with its handle masked, as a code is", async () => {
    const { lines } = await capture(async () => {
      for (const path of ["/api/players/Talleyrand", "/api/players/Talleyrand/ratings"]) await SELF.fetch(`http://cabal${path}`, { headers: { "cf-connecting-ip": nextIp() } });
      await SELF.fetch("http://cabal/api/players/recover", { method: "POST", body: "{}", headers: { "cf-connecting-ip": nextIp() } });
    });
    expect(lines.filter((l) => l.event === "request").map((l) => l.route)).toEqual([
      "GET /api/players/:handle",
      "GET /api/players/:handle/ratings",
      "POST /api/players/recover",
    ]);
    expect(JSON.stringify(lines)).not.toContain("Talleyrand");
  });

  it("masks the handles a thrown error quotes, in its message and its stack", () => {
    const error = new Error('no seat for handle "Talleyrand" (Envoy-4821, /u/Talleyrand)');
    const described = describeError(error);
    expect(described.error).toBe('Error: no seat for handle "<handle>" (<handle>, /u/<handle>)');
    expect(described.stack).not.toMatch(/Talleyrand|Envoy-4821/);
    expect(describeError("Courier-1000 left").error).toBe("<handle> left");
  });

  it("gives socket frames and alarms ids of their own, so a room's lines group by what woke it", async () => {
    const ann = await create("Ann");
    await start(ann);
    const client = await Client.connect(ann.gameId, ann.token);
    await client.next("welcome");
    const { lines } = await capture(async () => {
      client.send({ t: "ready", id: "r1", p: { phase: "S1901M", ready: true } });
      await deadlineIn(ann.gameId);
      await untilPhase(ann.gameId, (phase) => phase !== "S1901M");
    });
    client.close();
    const adjudicated = lines.find((l) => l.event === "phase_adjudicated")!;
    expect(adjudicated).toMatchObject({ service: "room", gameId: ann.gameId });
    expect(String(adjudicated.requestId)).toMatch(/^(ws|alarm)-[0-9a-f]{16}$/);
  });

  it("tags the queue consumer's lines with the message's id", async () => {
    const acked: string[] = [];
    const batch = {
      queue: "cabal-agent-turns",
      messages: [
        {
          id: "msg-0001",
          attempts: 1,
          timestamp: new Date(),
          body: { gameId: "QQQQQQ", power: "FRANCE", phase: "S1901M", step: "order" } satisfies AgentTurn,
          ack: () => acked.push("msg-0001"),
          retry: () => undefined,
        },
      ],
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch<AgentTurn>;
    const { lines } = await capture(() => worker.queue(batch, serverEnv));
    expect(acked).toEqual(["msg-0001"]);
    expect(lines.find((l) => l.event === "agent_turn")).toMatchObject({ service: "queue", requestId: "q-msg-0001", outcome: "stale" });
  });
});

describe("engine cold start", () => {
  it("times instantiation, the first game and the first adjudication once per isolate", async () => {
    const ann = await create("Ann");
    await start(ann);
    const client = await Client.connect(ann.gameId, ann.token);
    await client.next("welcome");
    client.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await client.next("results");
    client.close();
    for (const part of ["instantiateMs", "firstGameMs", "firstProcessMs"] as const) {
      expect(coldStart[part], part).not.toBeNull();
      expect(coldStart[part]!, part).toBeGreaterThanOrEqual(0);
    }
    // Measured once: later work of the same kind runs untimed and leaves the numbers as they were.
    const before = { ...coldStart };
    expect(timedFirst("firstProcessMs", () => 42)).toBe(42);
    expect(timedFirst("firstGameMs", () => "game")).toBe("game");
    expect(coldStart).toEqual(before);
  });
});

/** The HTTP API a lobby is built against: settings, listings, health, and failures that stay JSON. */
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { type GameListing, type GameRecord, GameSummary, HealthResponse, PROTOCOL_VERSION } from "@cabal/protocol";
import { version as engineVersion } from "@cabal/engine";
import worker from "../src/index.js";
import { D1_SCHEMA_REQUIRED, gameIndex } from "../src/game-index.js";
import { MIGRATIONS } from "../src/registry.js";
import { Client, D1_SCHEMA, create, deadlineIn, join, nextIp, serverEnv, start, summary, until, untilIndexed } from "./helpers.js";

const get = (path: string) => SELF.fetch(`http://cabal${path}`, { headers: { "cf-connecting-ip": nextIp() } });
const live = async (status: "open" | "active") => ((await (await get(`/api/games?status=${status}&limit=100`)).json()) as { games: GameListing[] }).games;

describe("creating a game", () => {
  it("takes the full settings a lobby offers and returns them resolved", async () => {
    const settings = {
      pacing: "live",
      press: "public",
      dias: false,
      scoring: "dss",
      aiBrain: "bot",
      aiFill: false,
      visibility: "public",
      publicVotes: false,
      ghostVotes: false,
      rulebook: "1971",
      whisperBudget: 3,
    };
    const ann = await create("Ann", settings);
    const s = GameSummary.parse(await (await get(`/api/games/${ann.gameId}`)).json());
    expect(s.settings).toMatchObject({ ...settings, movementSeconds: 600, shortPhaseSeconds: 300, graceSeconds: 60, extendSeconds: 300 });
    expect(s).toMatchObject({ status: "lobby", host: ann.power, phase: "S1901M", finished: null, history: [] });
    expect(s.seats.filter((seat) => seat.host).map((seat) => seat.power)).toEqual([ann.power]);
  });

  it("defaults to an unlisted Sum of Squares game with public votes, and refuses settings it does not know", async () => {
    const ann = await create("Ann");
    expect((await summary(ann.gameId)).settings).toMatchObject({ scoring: "sos", visibility: "unlisted", publicVotes: true, dias: true, aiBrain: "bot", aiFill: true });
    for (const bad of [{ scoring: "carnage" }, { visibility: "secret" }, { publicVotes: "yes" }]) {
      const res = await SELF.fetch("http://cabal/api/games", { method: "POST", headers: { "cf-connecting-ip": nextIp() }, body: JSON.stringify({ name: "Ann", settings: bad }) });
      expect(res.status).toBe(400);
    }
  });

  it("scores a draw by draw size when the game asks for it: equal shares for the sharers", async () => {
    const ann = await create("Ann", { aiFill: true, scoring: "dss" });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    await Promise.all([a.next("welcome"), b.next("welcome")]);
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    const finished = await a.next("finished");
    // Russia starts with four centres: under Sum of Squares its share would be larger than the rest.
    expect(new Set(Object.values(finished.p.scores).map((v) => v.toFixed(6)))).toEqual(new Set([(1 / 7).toFixed(6)]));
  });
});

describe("listing games", () => {
  it("lists a public game while it is open, then while it is running, then as finished; an unlisted game never", async () => {
    const pub = await create("Ann", { visibility: "public", aiFill: true, graceSeconds: 0 });
    const hidden = await create("Zed", { visibility: "unlisted", aiFill: true });
    const open = await until(async () => (await live("open")).find((g) => g.gameId === pub.gameId), "the lobby to be listed");
    expect(open).toMatchObject({ status: "lobby", hostName: "Ann", humans: 1, openSeats: 6, phase: "S1901M", cluster: "standard:full:async" });
    expect((await live("open")).some((g) => g.gameId === hidden.gameId)).toBe(false);

    const bob = await join(pub.gameId, "Bob");
    await until(async () => (await live("open")).find((g) => g.gameId === pub.gameId && g.humans === 2), "the second player to show");
    await start(pub);
    await start(hidden);
    const active = await until(async () => (await live("active")).find((g) => g.gameId === pub.gameId), "the running game to be listed");
    expect(active).toMatchObject({ status: "active", humans: 2, openSeats: 0 });
    expect(active.deadlineAt).toBeGreaterThan(Date.now());
    expect((await live("open")).some((g) => g.gameId === pub.gameId)).toBe(false);
    expect((await live("active")).some((g) => g.gameId === hidden.gameId)).toBe(false);

    const a = await Client.connect(pub.gameId, pub.token);
    const b = await Client.connect(pub.gameId, bob.token);
    await Promise.all([a.next("welcome"), b.next("welcome")]);
    // One phase is played (its clock runs out), then the two agree a draw.
    await deadlineIn(pub.gameId, 15);
    await a.next("state", (m) => m.p.phase !== "S1901M");
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    await a.next("finished");
    await untilIndexed(pub.gameId);
    await until(async () => !(await live("active")).some((g) => g.gameId === pub.gameId), "the finished game to leave the live list");
    const finished = ((await (await get("/api/games?status=finished&limit=100")).json()) as { games: GameRecord[] }).games;
    expect(finished.some((g) => g.gameId === pub.gameId)).toBe(true);
    // The default is still the finished list, and an unknown status is a 400.
    expect(((await (await get("/api/games?limit=100")).json()) as { status: string }).status).toBe("finished");
    expect((await get("/api/games?status=everything")).status).toBe(400);
  });

  it("never lists a game again once it has been recorded as ended, and drops listings nobody refreshes", async () => {
    const index = gameIndex(serverEnv)!;
    const pub = await create("Ann", { visibility: "public" });
    const listing = await until(async () => (await live("open")).find((g) => g.gameId === pub.gameId), "the lobby to be listed");
    // A listing its room stopped refreshing more than a week ago is left out.
    await index.upsertListing({ ...listing, gameId: "STALE1", updatedAt: Date.now() - 8 * 24 * 3600_000 });
    expect((await live("open")).some((g) => g.gameId === "STALE1")).toBe(false);
    // A refresh that arrives after the game was recorded must not resurrect it.
    const settings = (await summary(pub.gameId)).settings;
    await index.recordGame({
      gameId: "ENDED1", result: "draw", reason: "vote", winners: [], scores: {}, settings, cluster: "standard:full:async",
      phaseCount: 1, createdAt: 1, finishedAt: 2, ledger: {}, seats: [],
    });
    await index.upsertListing({ ...listing, gameId: "ENDED1", updatedAt: Date.now() });
    expect((await live("open")).some((g) => g.gameId === "ENDED1")).toBe(false);
    await index.removeListing(pub.gameId);
    expect((await live("open")).some((g) => g.gameId === pub.gameId)).toBe(false);
  });
});

describe("a table's centres", () => {
  it("answers who holds which supply centres now, the same for anyone, without the saved game", async () => {
    const seat = await create("Ann", { aiFill: true });
    const res = await SELF.fetch(`http://cabal/api/games/${seat.gameId}/centres`, { headers: { "cf-connecting-ip": nextIp() } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { gameId: string; phase: string; centers: Record<string, string[]> };
    expect(body.gameId).toBe(seat.gameId);
    expect(body.phase).toBe("S1901M");
    expect([...body.centers.RUSSIA!].sort()).toEqual(["MOS", "SEV", "STP", "WAR"]);
    expect(Object.keys(body)).toEqual(["gameId", "phase", "centers"]);
    expect((await SELF.fetch("http://cabal/api/games/ZZZZZZ/centres", { headers: { "cf-connecting-ip": nextIp() } })).status).toBe(404);
  });
});

describe("health and failure", () => {
  it("needs exactly the schema the newest migration file makes", () => {
    expect(D1_SCHEMA_REQUIRED).toBe(D1_SCHEMA);
  });

  it("reports the engine version, the build and whether the index answers", async () => {
    const health = HealthResponse.parse(await (await get("/health")).json());
    expect(health).toMatchObject({
      ok: true,
      protocol: PROTOCOL_VERSION,
      engine: engineVersion(),
      registry: { reachable: true, schema: MIGRATIONS.at(-1)!.version },
      index: { backend: "d1", reachable: true, schema: D1_SCHEMA },
    });
    // Asked again at once, it answers from memory: the index is probed at most once every few seconds.
    let probes = 0;
    const counting = { idFromName: () => "id", get: () => ({ schemaVersion: async () => (probes++, 9) }) } as never;
    for (let i = 0; i < 5; i++) await worker.fetch(new Request("http://cabal/health"), { ...serverEnv, REGISTRY: counting });
    expect(probes).toBe(1);
    expect(health.build.length).toBeGreaterThan(0);
    // The same answer under /api, where a web app's proxy forwards only /api to the server.
    expect(HealthResponse.parse(await (await get("/api/health")).json())).toMatchObject({ ok: true, engine: health.engine, build: health.build });
    expect(Math.abs(health.time - Date.now())).toBeLessThan(5_000);

    const named = await worker.fetch(new Request("http://cabal/health"), { ...serverEnv, BUILD_ID: "abc1234" });
    expect(((await named.json()) as HealthResponse).build).toBe("abc1234");
    // The commit and the Worker version are both named, so one curl shows which commit is live.
    const versioned = await worker.fetch(new Request("http://cabal/health"), {
      ...serverEnv,
      BUILD_ID: "3b30e06c5d9a",
      CF_VERSION_METADATA: { id: "7807fcf8-716d-4af9-8949-897dd3f6ac0f", tag: "3b30e06c5d9a", timestamp: "" },
    });
    expect(HealthResponse.parse(await versioned.json())).toMatchObject({ build: "3b30e06c5d9a", version: "7807fcf8-716d-4af9-8949-897dd3f6ac0f" });

    // An index that does not answer is reported, and health itself still answers.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = await worker.fetch(new Request("http://cabal/health"), {
      ...serverEnv,
      REGISTRY: { idFromName: () => "id", get: () => ({ schemaVersion: async () => Promise.reject(new Error("down")) }) } as never,
    });
    expect(down.status).toBe(200);
    expect(((await down.json()) as HealthResponse).registry).toEqual({ reachable: false, schema: null });
    const none = await worker.fetch(new Request("http://cabal/health"), { ...serverEnv, REGISTRY: undefined as never });
    expect(((await none.json()) as HealthResponse).registry.reachable).toBe(false);
    // The same for the D1 index; without one the Registry serves the games index, as before D1.
    const d1Down = await worker.fetch(new Request("http://cabal/health"), {
      ...serverEnv,
      DB: { prepare: () => ({ first: async () => Promise.reject(new Error("down")) }) } as never,
    });
    expect(d1Down.status).toBe(503);
    expect(await d1Down.json()).toMatchObject({ ok: false, index: { backend: "d1", reachable: false, schema: null } });
    // A database that answers but is behind this build (deployed before its migrations) is not healthy either.
    const behind = await worker.fetch(new Request("http://cabal/health"), {
      ...serverEnv,
      DB: { prepare: () => ({ first: async () => ({ name: `${String(D1_SCHEMA_REQUIRED - 1).padStart(4, "0")}_metrics.sql` }) }) } as never,
    });
    expect(behind.status).toBe(503);
    expect(await behind.json()).toMatchObject({ ok: false, index: { backend: "d1", reachable: true, schema: D1_SCHEMA_REQUIRED - 1 } });
    const noD1 = await worker.fetch(new Request("http://cabal/health"), { ...serverEnv, DB: undefined as never });
    expect(((await noD1.json()) as HealthResponse).index).toEqual({ backend: "registry", reachable: true, schema: MIGRATIONS.at(-1)!.version });
    expect(noD1.status).toBe(200);
    error.mockRestore();
  });

  it("turns an exception anywhere into a JSON 500 with CORS and one structured log line", async () => {
    const lines: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
    const broken = {
      ...serverEnv,
      GAME_ROOM: { idFromName: () => { throw new Error("storage is on fire"); } } as never,
    };
    const res = await worker.fetch(new Request("http://cabal/api/games/ABCDEF", { headers: { "cf-ray": "ray-123" } }), broken);
    error.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "internal error", requestId: "ray-123" });
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "unhandled_error")!;
    expect(logged).toMatchObject({ event: "unhandled_error", requestId: "ray-123", route: "GET /api/games/:id", error: "Error: storage is on fire" });
    // The response never repeats the error's text.
    expect(JSON.stringify(await (await worker.fetch(new Request("http://cabal/api/games/ABCDEF"), broken).catch(() => new Response("{}"))).json())).not.toContain("fire");
  });
});

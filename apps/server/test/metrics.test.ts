/** The phase 1 metrics: events in D1, anonymous beacons, the admin summary. */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type GameRecord, GameSettings, MetricsSummary } from "@cabal/protocol";
import worker from "../src/index.js";
import { BEACON_SAMPLES_PER_DAY } from "../src/metrics.js";
import { binOf } from "../src/stats.js";
import { index, nextIp, serverEnv } from "./helpers.js";

const ADMIN = "test-admin-token";
const db = () => serverEnv.DB!;

const beacon = (body: unknown, continent?: string) =>
  SELF.fetch("http://cabal/api/metrics", {
    method: "POST",
    headers: { "cf-connecting-ip": nextIp(), "content-type": "text/plain" },
    body: JSON.stringify(body),
    ...(continent ? { cf: { continent } } : {}),
  } as RequestInit);

const admin = (path: string, token: string | null = ADMIN, init: RequestInit = {}) =>
  SELF.fetch(`http://cabal${path}`, { ...init, headers: { "cf-connecting-ip": nextIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) } });

const summary = async (days?: number) => {
  const res = await admin(`/api/metrics${days ? `?days=${days}` : ""}`);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  return MetricsSummary.parse(await res.json());
};
const line = (s: MetricsSummary, id: string) => s.metrics.find((m) => m.id === id)!;

const NOW = Date.now();
const record = (gameId: string, over: Partial<GameRecord> = {}): GameRecord => ({
  gameId,
  result: "draw",
  reason: "engine_draw",
  winners: ["FRANCE", "ITALY"],
  scores: { FRANCE: 0.5, ITALY: 0.5 },
  settings: GameSettings.parse({}),
  cluster: "standard:full:async",
  phaseCount: 40,
  createdAt: NOW - 3_600_000,
  finishedAt: NOW,
  ledger: {},
  seats: [
    { power: "FRANCE", kind: "human", name: "Ann", centers: 17, eliminated: false },
    { power: "ITALY", kind: "ai", name: "Automaton", centers: 17, eliminated: false },
  ],
  ...over,
});

describe("before anything is measured", () => {
  it("reports every metric as unmeasured, with its target", async () => {
    const s = await summary();
    expect(s.metrics.map((m) => [m.id, m.status])).toEqual([
      ["datc", "unmeasured"],
      ["full_game", "unmeasured"],
      ["landing_to_game", "unmeasured"],
      ["order_rtt", "unmeasured"],
    ]);
    expect(line(s, "order_rtt").target).toBe("p95 under 150 ms");
    expect(s.to - s.from).toBe(30 * 24 * 3600_000);
  });
});

describe("the admin routes", () => {
  it("need the admin token, and do not exist without one configured", async () => {
    expect((await admin("/api/metrics", null)).status).toBe(401);
    expect((await admin("/api/metrics", "not-the-token")).status).toBe(401);
    const unconfigured = await worker.fetch(new Request("http://cabal/api/metrics", { headers: { authorization: `Bearer ${ADMIN}` } }), { ...serverEnv, ADMIN_TOKEN: "" });
    expect(unconfigured.status).toBe(404);
    const datc = await worker.fetch(new Request("http://cabal/api/metrics/datc", { method: "POST", body: "{}" }), { ...serverEnv, ADMIN_TOKEN: "" });
    expect(datc.status).toBe(404);
  });
});

describe("DATC", () => {
  it("records a commit's totals once and judges the latest report", async () => {
    const report = { passed: 171, failed: 0, skipped: 0, commit: "a582be1", engine: "0.1.0" };
    const post = (body: unknown) => admin("/api/metrics/datc", ADMIN, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ ...report, commit: "main" })).status).toBe(400);
    expect((await admin("/api/metrics/datc", null, { method: "POST", body: JSON.stringify(report) })).status).toBe(401);
    expect(await (await post(report)).json()).toEqual({ recorded: true });
    expect(await (await post(report)).json()).toEqual({ recorded: false });
    let datc = line(await summary(), "datc");
    expect(datc).toMatchObject({ status: "pass", value: 171, unit: "cases passed", samples: 1, detail: report });
    // A later report with a failure turns it red.
    await post({ ...report, passed: 170, failed: 1, commit: "b000000" });
    datc = line(await summary(), "datc");
    expect(datc).toMatchObject({ status: "fail", value: 170 });
  });
});

describe("a full game", () => {
  it("is recorded from the game's own record, once however often the hand-off is retried", async () => {
    await index().recordGame(record("MTRC01"));
    await index().recordGame(record("MTRC01"));
    await index().recordGame(record("MTRC02", { result: "abandoned", reason: "no_orders", winners: [], scores: {}, phaseCount: 9 }));
    // A game that never played a phase is not a game.
    await index().recordGame(record("MTRC03", { result: "abandoned", reason: "no_orders", phaseCount: 0 }));
    const rows = await db().prepare("SELECT dedupe, ok, value, region, detail_json FROM metric_events WHERE metric = 'full_game' ORDER BY dedupe").all<{ dedupe: string; ok: number; value: number; region: string | null; detail_json: string }>();
    expect(rows.results.map((r) => [r.dedupe, r.ok, r.value])).toEqual([
      ["full_game:MTRC01", 1, 40],
      ["full_game:MTRC02", 0, 9],
    ]);
    // No names, no players: only the shape of the game.
    expect(rows.results[0]!.detail_json).not.toContain("Ann");
    expect(JSON.parse(rows.results[0]!.detail_json)).toEqual({ result: "draw", reason: "engine_draw", seats: 2, humans: 1, ai: 1, phases: 40, durationMs: 3_600_000, pacing: "async" });
    const games = line(await summary(), "full_game");
    expect(games).toMatchObject({ status: "pass", value: 1, samples: 2 });
    expect(games.detail).toMatchObject({ completed: 1, abandoned: 1, reasons: { engine_draw: 1, no_orders: 1 } });
  });
});

describe("browser timings", () => {
  it("take anonymous, bounded samples into a daily histogram that keeps only the continent", async () => {
    expect((await beacon({ samples: [{ metric: "order_rtt", ms: -5 }] })).status).toBe(400);
    expect((await beacon({ samples: [{ metric: "datc", ms: 5 }] })).status).toBe(400);
    expect((await beacon("not json at all")).status).toBe(400);
    // At most ten samples a beacon.
    expect((await beacon({ samples: Array.from({ length: 11 }, () => ({ metric: "order_rtt", ms: 50 })) })).status).toBe(400);
    const res = await beacon({ samples: [{ metric: "landing_to_game", ms: 38_000 }, { metric: "landing_to_game", ms: 38_100 }] }, "EU");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // Two samples in one bin are one row.
    const rows = (await db().prepare("SELECT * FROM metric_buckets WHERE metric = 'landing_to_game'").all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric: "landing_to_game", region: "EU", bin: binOf(38_000), n: 2, day: Math.floor(Date.now() / 86_400_000) * 86_400_000 });
    // Nothing about who sent it.
    expect(Object.keys(rows[0]!).sort()).toEqual(["bin", "day", "metric", "n", "region"]);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM metric_events WHERE metric IN ('order_rtt', 'landing_to_game')").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("judge the round trip on the p95 from Europe and North America, and show every region", async () => {
    const eu = Array.from({ length: 19 }, (_, i) => ({ metric: "order_rtt", ms: 60 + i }));
    for (let i = 0; i < eu.length; i += 10) await beacon({ samples: eu.slice(i, i + 10) }, "EU");
    await beacon({ samples: [{ metric: "order_rtt", ms: 140 }] }, "EU");
    await beacon({ samples: [{ metric: "order_rtt", ms: 90 }, { metric: "order_rtt", ms: 95 }] }, "NA");
    // Slow from Oceania, which the target does not cover.
    await beacon({ samples: [{ metric: "order_rtt", ms: 400 }, { metric: "order_rtt", ms: 420 }] }, "OC");
    await beacon({ samples: [{ metric: "landing_to_game", ms: 45_000 }, { metric: "landing_to_game", ms: 70_000 }] }, "NA");
    const s = await summary(7);
    const rtt = line(s, "order_rtt");
    expect(rtt.status).toBe("pass");
    expect(rtt.samples).toBe(22);
    expect(rtt.value).toBeLessThan(150);
    expect(rtt.detail.source).toMatch(/^self-reported/);
    expect(Object.keys(rtt.detail.regions as object).sort()).toEqual(["EU", "NA", "OC"]);
    expect((rtt.detail.regions as Record<string, { n: number }>).OC!.n).toBe(2);
    const landing = line(s, "landing_to_game");
    expect(landing).toMatchObject({ status: "pass", samples: 4 });
    // The median of 38,000, 38,100, 45,000 and 70,000, read from the histogram: within 2.5 percent.
    expect(Math.abs(landing.value! - 41_550) / 41_550).toBeLessThan(0.025);

    // Enough slow samples from Europe and the target is missed.
    for (let i = 0; i < 2; i++) await beacon({ samples: Array.from({ length: 10 }, () => ({ metric: "order_rtt", ms: 900 })) }, "EU");
    expect(line(await summary(), "order_rtt").status).toBe("fail");
  });

  it("let one address send six beacons a minute, each at most a row per bin", async () => {
    const before = (await db().prepare("SELECT COALESCE(SUM(n), 0) AS n, COUNT(*) AS rows FROM metric_buckets").first<{ n: number; rows: number }>())!;
    const ip = "203.0.113.77";
    const samples = Array.from({ length: 10 }, () => ({ metric: "order_rtt", ms: 59_999 }));
    const statuses: number[] = [];
    // Forty beacons in a row from one address, as a script or a hostile page could send them.
    for (let i = 0; i < 40; i++) {
      const res = await SELF.fetch("http://cabal/api/metrics", { method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify({ samples }), cf: { continent: "EU" } } as RequestInit);
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 204)).toHaveLength(6);
    expect(statuses.filter((s) => s === 429)).toHaveLength(34);
    const after = (await db().prepare("SELECT COALESCE(SUM(n), 0) AS n, COUNT(*) AS rows FROM metric_buckets").first<{ n: number; rows: number }>())!;
    expect(after.n - before.n).toBe(60);
    // Sixty samples in one bin stay one row.
    expect(after.rows - before.rows).toBeLessThanOrEqual(1);
  });

  it("refuse a beacon from a page on another origin", async () => {
    const send = (origin: string) =>
      SELF.fetch("http://cabal/api/metrics", { method: "POST", headers: { "cf-connecting-ip": nextIp(), origin }, body: JSON.stringify({ samples: [{ metric: "order_rtt", ms: 1 }] }) });
    expect((await send("https://evil.example")).status).toBe(403);
    expect((await send("http://cabal")).status).toBe(204);
    expect((await send("http://localhost:5173")).status).toBe(204);
    // A deployment, reached over https, takes nothing from a page on someone's own machine.
    const deployed = await SELF.fetch("https://cabal-server.example/api/metrics", {
      method: "POST",
      headers: { "cf-connecting-ip": nextIp(), origin: "http://localhost:5173" },
      body: JSON.stringify({ samples: [{ metric: "order_rtt", ms: 1 }] }),
    });
    expect(deployed.status).toBe(403);
  });

  it("stop for the day at the deployment's cap, whatever the number of addresses", async () => {
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const read = async () => (await db().prepare("SELECT samples FROM metric_beacon_days WHERE day = ?").bind(day).first<{ samples: number }>())?.samples ?? 0;
    const sum = async () => (await db().prepare("SELECT COALESCE(SUM(n), 0) AS n FROM metric_buckets WHERE day = ?").bind(day).first<{ n: number }>())!.n;
    // Bring the day's count to three short of the cap.
    await db().prepare("UPDATE metric_beacon_days SET samples = ? WHERE day = ?").bind(BEACON_SAMPLES_PER_DAY - 3, day).run();
    const before = await sum();
    // Five samples would pass the cap: the whole beacon is dropped, and still answered 204.
    expect((await beacon({ samples: Array.from({ length: 5 }, () => ({ metric: "order_rtt", ms: 70 })) }, "NA")).status).toBe(204);
    expect(await sum()).toBe(before);
    expect(await read()).toBe(BEACON_SAMPLES_PER_DAY - 3);
    // Three fit exactly; then nothing more today.
    expect((await beacon({ samples: Array.from({ length: 3 }, () => ({ metric: "order_rtt", ms: 70 })) }, "NA")).status).toBe(204);
    expect(await sum()).toBe(before + 3);
    expect(await read()).toBe(BEACON_SAMPLES_PER_DAY);
    expect((await beacon({ samples: [{ metric: "order_rtt", ms: 70 }] }, "NA")).status).toBe(204);
    expect(await sum()).toBe(before + 3);
    await db().prepare("UPDATE metric_beacon_days SET samples = 0 WHERE day = ?").bind(day).run();
  });
});

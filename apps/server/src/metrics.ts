/**
 * The phase 1 success metrics (docs/PLAN.md section 8, issue #57), recorded as events in D1 and
 * summarised for an operator. No third-party analytics and no personal data: events carry no
 * player, address or device, and browser timings only the continent the request came from.
 *
 *   POST /api/metrics        anonymous timings a browser measured (`MetricsBeacon`), answered 204
 *   POST /api/metrics/datc   admin: the DATC totals `cabal datc` printed for a commit
 *   GET  /api/metrics        admin: every metric over a window (`days`, default 30), pass or fail
 *
 * The admin routes need `Authorization: Bearer <ADMIN_TOKEN>` and do not exist (404) where that
 * secret is not set. Finished games are recorded by the index itself (d1-index.ts), in the same
 * batch as the game's own row, so a retried hand-off can never count a game twice.
 */
import { DatcReport, type GameRecord, type MetricLine, MetricsBeacon, type MetricsSummary } from "@cabal/protocol";
import type { Env } from "./env.js";
import { json, limited, readJson, tooMany, withCors } from "./http.js";
import { log } from "./log.js";
import { summarise } from "./stats.js";
import { hashToken, sameHash } from "./tokens.js";

/** Targets, as PLAN.md states them. */
export const TARGETS = {
  orderRttP95Ms: 150,
  landingToGameMs: 60_000,
} as const;

/** Events older than this are deleted when the summary is read. */
export const RETENTION_MS = 400 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
/** The regions the round trip target names. */
const TARGET_REGIONS = ["EU", "NA"];
/** At most this many timing samples are read per metric for one summary: the most recent. */
const SAMPLE_CAP = 50_000;

/** The continent Cloudflare saw a request from, or `XX`. Nothing finer is ever kept. */
export function continentOf(request: Request): string {
  const continent = (request as Request & { cf?: { continent?: unknown } }).cf?.continent;
  return typeof continent === "string" && /^[A-Z]{2}$/.test(continent) ? continent : "XX";
}

/** The statement that records a finished game's metric event; part of the index's batch. */
export function fullGameEvent(db: D1Database, record: GameRecord): D1PreparedStatement | null {
  // A game that never played a phase is not a game for this purpose.
  if (record.phaseCount === 0) return null;
  const humans = record.seats.filter((s) => s.kind === "human" || s.kind === "civil_disorder").length;
  const completed = record.result === "solo" || record.result === "draw";
  const detail = {
    result: record.result,
    reason: record.reason,
    seats: record.seats.length,
    humans,
    ai: record.seats.filter((s) => s.kind === "ai").length,
    phases: record.phaseCount,
    durationMs: record.finishedAt - record.createdAt,
    pacing: record.settings.pacing,
  };
  return db
    .prepare("INSERT OR IGNORE INTO metric_events (metric, at, value, ok, region, detail_json, dedupe) VALUES ('full_game', ?, ?, ?, NULL, ?, ?)")
    .bind(record.finishedAt, record.phaseCount, completed ? 1 : 0, JSON.stringify(detail), `full_game:${record.gameId}`);
}

/** True when the request carries this deployment's admin token. */
async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  return Boolean(env.ADMIN_TOKEN) && bearer.length > 0 && sameHash(hashToken(bearer), hashToken(env.ADMIN_TOKEN!));
}

const noStore = (res: Response) => {
  res.headers.set("cache-control", "private, no-store");
  return res;
};

/** Serve a metrics route, or return null when the path is not one. */
export async function metricsRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/api/metrics" && path !== "/api/metrics/datc") return null;
  const db = env.DB;

  if (path === "/api/metrics" && request.method === "POST") {
    if (await limited(env.READ_LIMITER, request, "metrics")) return tooMany();
    const body = MetricsBeacon.safeParse(await readJson(request));
    if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
    if (db) {
      const region = continentOf(request);
      const now = Date.now();
      await db.batch(
        body.data.samples.map((s) => db.prepare("INSERT INTO metric_events (metric, at, value, ok, region) VALUES (?, ?, ?, NULL, ?)").bind(s.metric, now, s.ms, region)),
      );
    }
    return withCors(new Response(null, { status: 204 }));
  }

  // Everything below is for the operator, and does not exist without the admin secret.
  if (!env.ADMIN_TOKEN) return withCors(json({ error: "not found" }, 404));
  if (await limited(env.READ_LIMITER, request, "metrics-admin")) return tooMany();
  if (!(await isAdmin(request, env))) return withCors(json({ error: "send the admin token as a bearer token" }, 401));
  if (!db) return withCors(json({ error: "metrics need the D1 database" }, 503));

  if (path === "/api/metrics/datc" && request.method === "POST") {
    const body = DatcReport.safeParse(await readJson(request));
    if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
    const r = body.data;
    const ok = r.failed === 0 && r.skipped === 0 ? 1 : 0;
    const result = await db
      .prepare("INSERT OR IGNORE INTO metric_events (metric, at, value, ok, region, detail_json, dedupe) VALUES ('datc', ?, ?, ?, NULL, ?, ?)")
      .bind(Date.now(), r.passed, ok, JSON.stringify(r), `datc:${r.commit}:${r.passed}:${r.failed}:${r.skipped}`)
      .run();
    log("metrics_datc_recorded", { commit: r.commit, passed: r.passed, failed: r.failed, skipped: r.skipped });
    return withCors(noStore(json({ recorded: (result.meta.changes ?? 0) > 0 }, 201)));
  }

  if (path === "/api/metrics" && request.method === "GET") {
    const days = Number(url.searchParams.get("days") ?? "30");
    const now = Date.now();
    const from = now - Math.min(400, Math.max(1, Number.isFinite(days) ? days : 30)) * DAY_MS;
    await db.prepare("DELETE FROM metric_events WHERE at < ?").bind(now - RETENTION_MS).run();
    return withCors(noStore(json(await summary(db, from, now))));
  }
  return withCors(json({ error: "not found" }, 404));
}

interface EventRow {
  at: number;
  value: number;
  ok: number | null;
  region: string | null;
  detail_json: string | null;
}

async function events(db: D1Database, metric: string, from: number, to: number, limit = SAMPLE_CAP): Promise<EventRow[]> {
  const rows = await db
    .prepare("SELECT at, value, ok, region, detail_json FROM metric_events WHERE metric = ? AND at >= ? AND at <= ? ORDER BY at DESC LIMIT ?")
    .bind(metric, from, to, limit)
    .all<EventRow>();
  return rows.results;
}

/** Every metric over `[from, to]`, judged against its target. */
export async function summary(db: D1Database, from: number, to: number): Promise<MetricsSummary> {
  const metrics: MetricLine[] = [];

  // DATC is a property of the engine, not of a time window: the latest report stands.
  const datc = (await events(db, "datc", 0, to, 1))[0];
  const report = datc?.detail_json ? (JSON.parse(datc.detail_json) as DatcReport) : null;
  metrics.push({
    id: "datc",
    title: "DATC v3.0 compliance",
    target: "every case passes, none skipped",
    status: datc ? (datc.ok === 1 ? "pass" : "fail") : "unmeasured",
    value: report?.passed ?? null,
    unit: "cases passed",
    samples: datc ? 1 : 0,
    lastAt: datc?.at ?? null,
    detail: report ? { ...report } : {},
  });

  const games = (await events(db, "full_game", from, to)).map((g) => ({
    ...g,
    detail: g.detail_json ? (JSON.parse(g.detail_json) as { reason: string | null; durationMs: number }) : null,
  }));
  const completed = games.filter((g) => g.ok === 1);
  const reasons: Record<string, number> = {};
  for (const g of games) if (g.detail?.reason) reasons[g.detail.reason] = (reasons[g.detail.reason] ?? 0) + 1;
  metrics.push({
    id: "full_game",
    title: "A full seven-seat game completes with no manual intervention",
    target: "at least one game reaches a solo or a draw by its own rules",
    status: games.length === 0 ? "unmeasured" : completed.length > 0 ? "pass" : "fail",
    value: completed.length,
    unit: "games completed",
    samples: games.length,
    lastAt: games[0]?.at ?? null,
    detail: {
      completed: completed.length,
      abandoned: games.length - completed.length,
      reasons,
      phases: summarise(completed.map((g) => g.value)),
      durationMs: summarise(completed.map((g) => g.detail?.durationMs ?? Number.NaN)),
    },
  });

  const landing = await events(db, "landing_to_game", from, to);
  const landingStats = summarise(landing.map((e) => e.value));
  metrics.push({
    id: "landing_to_game",
    title: "Landing page to a game in progress",
    target: "median under 60 seconds, AI seats filling the table",
    status: landingStats ? (landingStats.median < TARGETS.landingToGameMs ? "pass" : "fail") : "unmeasured",
    value: landingStats?.median ?? null,
    unit: "ms (median)",
    samples: landing.length,
    lastAt: landing[0]?.at ?? null,
    detail: { ...(landingStats ? { stats: landingStats } : {}) },
  });

  const rtt = await events(db, "order_rtt", from, to);
  const target = rtt.filter((e) => e.region !== null && TARGET_REGIONS.includes(e.region));
  const rttStats = summarise(target.map((e) => e.value));
  const byRegion: Record<string, unknown> = {};
  for (const region of [...new Set(rtt.map((e) => e.region ?? "XX"))].sort()) {
    byRegion[region] = summarise(rtt.filter((e) => (e.region ?? "XX") === region).map((e) => e.value));
  }
  metrics.push({
    id: "order_rtt",
    title: "Order submit round trip from a browser in Europe or North America",
    target: "p95 under 150 ms",
    status: rttStats ? (rttStats.p95 < TARGETS.orderRttP95Ms ? "pass" : "fail") : "unmeasured",
    value: rttStats?.p95 ?? null,
    unit: "ms (p95)",
    samples: target.length,
    lastAt: rtt[0]?.at ?? null,
    detail: { regions: byRegion, ...(rttStats ? { stats: rttStats } : {}) },
  });

  return { from, to, metrics };
}

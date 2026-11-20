/**
 * The phase 1 success metrics (docs/PLAN.md section 8, issue #57), recorded as events in D1 and
 * summarised for an operator. No third-party analytics and no personal data: events carry no
 * player, address or device, and browser timings only the continent the request came from.
 *
 *   POST /api/metrics        anonymous timings a browser measured (`MetricsBeacon`), answered 204
 *   POST /api/metrics/datc   admin: the DATC totals `cabal datc` printed for a commit
 *   GET  /api/metrics        admin: every metric over a window (`days`, default 30), pass or fail
 *
 * Beacons are anonymous, so what they can cost is bounded three ways: a beacon carries at most 10
 * samples, one address may send `METRICS_LIMITER` beacons a minute (6), and the whole deployment
 * accepts at most `BEACON_SAMPLES_PER_DAY` samples a day. Samples are folded into daily histograms
 * (`metric_buckets`, one row per metric, day, continent and bin), never one row each, so storage
 * stays bounded whatever the traffic. A beacon from a page on another origin is refused. The
 * figures they give are self-reported by browsers, and the summary says so.
 *
 * The admin routes need `Authorization: Bearer <ADMIN_TOKEN>` and do not exist (404) where that
 * secret is not set. Finished games are recorded by the index itself (d1-index.ts), in the same
 * batch as the game's own row, so a retried hand-off can never count a game twice.
 */
import { DatcReport, type GameRecord, type MetricLine, MetricsBeacon, type MetricsSummary } from "@cabal/protocol";
import type { Env } from "./env.js";
import { json, limited, readJson, tooMany, withCors } from "./http.js";
import { log } from "./log.js";
import { binOf, summarise, summariseBins } from "./stats.js";
import { hashToken, sameHash } from "./tokens.js";

/** Targets, as PLAN.md states them. */
export const TARGETS = {
  orderRttP95Ms: 150,
  landingToGameMs: 60_000,
} as const;

/** Events and histogram days older than this are deleted when the summary is read. */
export const RETENTION_MS = 400 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
/** Browser samples the whole deployment accepts in one UTC day; the rest of the day's beacons are dropped. */
export const BEACON_SAMPLES_PER_DAY = 20_000;
const dayOf = (at: number) => Math.floor(at / DAY_MS) * DAY_MS;
/** Where the browser figures come from, for whoever reads the summary. */
const SELF_REPORTED = "self-reported by anonymous browsers; at most 10 samples a beacon, 6 beacons a minute an address, 20,000 samples a day; figures within 2.5 percent";
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

/**
 * A beacon comes from this deployment's own pages: no `Origin` (not a browser, or a same-origin
 * request that sent none), the origin the request was made to (the web app forwards `/api` with its
 * own URL), or a local development server talking to a local server (plain http: a deployment is
 * only ever reached over https, so a page on someone's localhost cannot post to it). Any other page
 * cannot make its visitors send one. This keeps other sites' visitors out; it authenticates nobody,
 * so the per-address limiter is what bounds a script that sets the header itself.
 */
export function beaconOriginAllowed(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === url.origin) return true;
  if (url.protocol !== "http:") return false;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Fold one beacon into the day's histograms, all or nothing, unless the day's cap is reached.
 * Samples that land in the same bin are one write.
 */
async function recordBeacon(db: D1Database, samples: readonly { metric: string; ms: number }[], region: string, now: number): Promise<void> {
  const day = dayOf(now);
  const counts = new Map<string, { metric: string; bin: number; n: number }>();
  for (const s of samples) {
    const bin = binOf(s.ms);
    const key = `${s.metric} ${bin}`;
    const was = counts.get(key);
    if (was) was.n += 1;
    else counts.set(key, { metric: s.metric, bin, n: 1 });
  }
  const total = samples.length;
  const underCap = "COALESCE((SELECT samples FROM metric_beacon_days WHERE day = ?), 0) + ? <= ?";
  await db.batch([
    ...[...counts.values()].map((c) =>
      db
        .prepare(
          `INSERT INTO metric_buckets (metric, day, region, bin, n) SELECT ?, ?, ?, ?, ? WHERE ${underCap}
           ON CONFLICT (metric, day, region, bin) DO UPDATE SET n = n + excluded.n`,
        )
        .bind(c.metric, day, region, c.bin, c.n, day, total, BEACON_SAMPLES_PER_DAY),
    ),
    // The day's count goes last, so every statement above judged the cap on the same figure.
    db
      .prepare(`INSERT INTO metric_beacon_days (day, samples) SELECT ?, ? WHERE ${underCap} ON CONFLICT (day) DO UPDATE SET samples = samples + excluded.samples`)
      .bind(day, total, day, total, BEACON_SAMPLES_PER_DAY),
  ]);
}

/** True when the request carries this deployment's admin token. */
export async function isAdmin(request: Request, env: Env): Promise<boolean> {
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
    if (!beaconOriginAllowed(request, url)) return withCors(json({ error: "beacons come from this deployment's own pages" }, 403));
    if (await limited(env.METRICS_LIMITER, request, "metrics")) return tooMany();
    const body = MetricsBeacon.safeParse(await readJson(request));
    if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
    if (db) await recordBeacon(db, body.data.samples, continentOf(request), Date.now());
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
    await db.batch([
      // By metric, so the delete reads the (metric, at) index rather than the whole table.
      db.prepare("DELETE FROM metric_events WHERE metric IN ('datc', 'full_game', 'landing_to_game', 'order_rtt') AND at < ?").bind(now - RETENTION_MS),
      db.prepare("DELETE FROM metric_buckets WHERE metric IN ('landing_to_game', 'order_rtt') AND day < ?").bind(dayOf(now - RETENTION_MS)),
      db.prepare("DELETE FROM metric_beacon_days WHERE day < ?").bind(dayOf(now - RETENTION_MS)),
    ]);
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

interface BucketRow {
  region: string;
  bin: number;
  n: number;
  last: number;
}

/** A browser metric's histogram over the days `[from, to]` touch, per continent and bin. */
async function buckets(db: D1Database, metric: string, from: number, to: number): Promise<BucketRow[]> {
  const rows = await db
    .prepare("SELECT region, bin, SUM(n) AS n, MAX(day) AS last FROM metric_buckets WHERE metric = ? AND day >= ? AND day <= ? GROUP BY region, bin")
    .bind(metric, dayOf(from), dayOf(to))
    .all<BucketRow>();
  return rows.results;
}

const histogram = (rows: readonly BucketRow[]) => {
  const bins = new Map<number, number>();
  for (const r of rows) bins.set(r.bin, (bins.get(r.bin) ?? 0) + r.n);
  return summariseBins(bins);
};
const lastDay = (rows: readonly BucketRow[]) => (rows.length === 0 ? null : Math.max(...rows.map((r) => r.last)));

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

  const landing = await buckets(db, "landing_to_game", from, to);
  const landingStats = histogram(landing);
  metrics.push({
    id: "landing_to_game",
    title: "Landing page to a game in progress",
    target: "median under 60 seconds, AI seats filling the table",
    status: landingStats ? (landingStats.median < TARGETS.landingToGameMs ? "pass" : "fail") : "unmeasured",
    value: landingStats?.median ?? null,
    unit: "ms (median)",
    samples: landingStats?.n ?? 0,
    lastAt: lastDay(landing),
    detail: { source: SELF_REPORTED, ...(landingStats ? { stats: landingStats } : {}) },
  });

  const rtt = await buckets(db, "order_rtt", from, to);
  const rttStats = histogram(rtt.filter((r) => TARGET_REGIONS.includes(r.region)));
  const byRegion: Record<string, unknown> = {};
  for (const region of [...new Set(rtt.map((r) => r.region))].sort()) byRegion[region] = histogram(rtt.filter((r) => r.region === region));
  metrics.push({
    id: "order_rtt",
    title: "Order submit round trip from a browser in Europe or North America",
    target: "p95 under 150 ms",
    status: rttStats ? (rttStats.p95 < TARGETS.orderRttP95Ms ? "pass" : "fail") : "unmeasured",
    value: rttStats?.p95 ?? null,
    unit: "ms (p95)",
    samples: rttStats?.n ?? 0,
    lastAt: lastDay(rtt),
    detail: { source: SELF_REPORTED, regions: byRegion, ...(rttStats ? { stats: rttStats } : {}) },
  });

  return { from, to, metrics };
}

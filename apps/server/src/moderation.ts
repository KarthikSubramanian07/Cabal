/**
 * Moderation hooks (issue #12): players report players, and a burst of accounts from one network
 * address is logged for review. Nothing here acts on its own; a maintainer reads and decides.
 *
 *   POST /api/players/:handle/report   signed in: report a player (players.ts routes it here)
 *   GET  /api/reports                  admin: recent reports and busy addresses, newest first
 *
 * A report is one row per reporter, player and UTC day (more change nothing). The address heuristic
 * keeps no address: a SHA-256 of the day and the address, and how many accounts it made that day,
 * kept for two days. From `MULTI_ACCOUNT_REVIEW` accounts in a day, each new one is logged as
 * `multi_account_suspect` with its id, for a maintainer to look at.
 */
import { type PlayerReportRequest, type ReportsResponse } from "@cabal/protocol";
import type { Env } from "./env.js";
import { json, limited, tooMany, withCors } from "./http.js";
import { log } from "./log.js";
import { isAdmin } from "./metrics.js";

const DAY_MS = 24 * 3600_000;
const dayOf = (at: number) => Math.floor(at / DAY_MS) * DAY_MS;
/** Accounts from one address in one UTC day from which each new one is logged for review. */
export const MULTI_ACCOUNT_REVIEW = 3;
/** Reports listed for review at once. */
const REVIEW_PAGE = 100;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Count a new account against the address it was made from, and log it for review once that
 * address has made `MULTI_ACCOUNT_REVIEW` accounts today. Returns the day's count. Never throws:
 * a moderation hook must not cost a player their account.
 */
export async function noteAccountOrigin(db: D1Database | undefined, request: Request, playerId: string, now: number): Promise<number> {
  const address = request.headers.get("cf-connecting-ip");
  if (!db || !address) return 0;
  try {
    const day = dayOf(now);
    const key = await sha256Hex(`${day}:${address}`);
    const [, counted] = await db.batch([
      db.prepare("DELETE FROM account_origins WHERE day < ?").bind(day - DAY_MS),
      db
        .prepare("INSERT INTO account_origins (origin_key, day, accounts) VALUES (?, ?, 1) ON CONFLICT (origin_key, day) DO UPDATE SET accounts = accounts + 1 RETURNING accounts")
        .bind(key, day),
    ]);
    const accounts = (counted!.results[0] as { accounts: number } | undefined)?.accounts ?? 0;
    if (accounts >= MULTI_ACCOUNT_REVIEW) log("multi_account_suspect", { playerId, accountsToday: accounts });
    return accounts;
  } catch (error) {
    log("account_origin_failed", { message: error instanceof Error ? error.message : String(error) }, "error");
    return 0;
  }
}

export type ReportOutcome = "filed" | "again" | "self";

/** File a report from `reporterId` about `subjectId`. */
export async function fileReport(db: D1Database, reporterId: string, subjectId: string, report: PlayerReportRequest, now: number): Promise<ReportOutcome> {
  if (reporterId === subjectId) return "self";
  const result = await db
    .prepare("INSERT OR IGNORE INTO player_reports (reporter_id, subject_id, reason, note, game_id, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(reporterId, subjectId, report.reason, report.note || null, report.gameId ?? null, dayOf(now), now)
    .run();
  const filed = (result.meta.changes ?? 0) > 0;
  // The log line is the alert: a maintainer filters Workers Logs on `player_reported`.
  if (filed) log("player_reported", { subjectId, reason: report.reason, gameId: report.gameId ?? null });
  return filed ? "filed" : "again";
}

/** Forget a deleted player in the moderation tables: their own reports stay, without their id. */
export function forgetInModeration(db: D1Database, playerId: string): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE player_reports SET reporter_id = NULL WHERE reporter_id = ?").bind(playerId),
    db.prepare("DELETE FROM player_reports WHERE subject_id = ?").bind(playerId),
  ];
}

interface ReportRow {
  id: number;
  reporter: string | null;
  subject: string | null;
  subject_id: string;
  reason: ReportsResponse["reports"][number]["reason"];
  note: string | null;
  game_id: string | null;
  created_at: number;
}

/** Serve `GET /api/reports` (admin), or null when the path is not it. */
export async function reportsRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/reports") return null;
  if (!env.ADMIN_TOKEN || request.method !== "GET") return withCors(json({ error: "not found" }, 404));
  if (await limited(env.READ_LIMITER, request, "reports-admin")) return tooMany();
  if (!(await isAdmin(request, env))) return withCors(json({ error: "send the admin token as a bearer token" }, 401));
  if (!env.DB) return withCors(json({ error: "reports need the D1 database" }, 503));
  const [reports, origins] = await env.DB.batch([
    env.DB.prepare(
      `SELECT r.id, rp.handle AS reporter, sp.handle AS subject, r.subject_id, r.reason, r.note, r.game_id, r.created_at
       FROM player_reports r LEFT JOIN players rp ON rp.id = r.reporter_id LEFT JOIN players sp ON sp.id = r.subject_id
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    ).bind(REVIEW_PAGE),
    env.DB.prepare("SELECT day, accounts FROM account_origins WHERE accounts >= ? ORDER BY day DESC, accounts DESC").bind(MULTI_ACCOUNT_REVIEW),
  ]);
  const body: ReportsResponse = {
    reports: (reports!.results as unknown as ReportRow[]).map((r) => ({
      id: r.id,
      reporter: r.reporter,
      subject: r.subject ?? r.subject_id,
      reason: r.reason,
      note: r.note,
      gameId: r.game_id,
      at: r.created_at,
    })),
    busyOrigins: origins!.results as unknown as ReportsResponse["busyOrigins"],
  };
  const res = json(body);
  res.headers.set("cache-control", "private, no-store");
  return withCors(res);
}

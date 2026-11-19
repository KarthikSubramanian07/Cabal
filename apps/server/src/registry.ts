/**
 * Registry: the one global index of games, a singleton SQLite-backed Durable Object
 * (`env.REGISTRY`, `idFromName("global")`).
 *
 * Game rooms hand their final summary here when a game is finished or abandoned, and public games
 * keep a live listing here while they are open or running. Nothing calls these methods directly:
 * callers go through the `GameIndex` port (game-index.ts), of which this class is the SQLite
 * adapter. The schema lives in numbered SQL files under `migrations/` and is brought up to date in
 * the constructor, so a deploy never needs a separate migration step.
 */
import { DurableObject } from "cloudflare:workers";
import { GameListing, GameRecord } from "@cabal/protocol";
import m0001 from "../migrations/0001_games_index.sql";
import m0002 from "../migrations/0002_games_index_seats_and_cluster.sql";
import m0003 from "../migrations/0003_games_live.sql";
import type { Env } from "./env.js";

/** Name of the singleton instance. */
export const REGISTRY_NAME = "global";

/**
 * Versioned schema, one plain SQL file per migration (valid for SQLite here and for D1 later).
 * Add a file and a line; never edit a migration that has shipped.
 */
export const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  { version: 1, name: "games_index", sql: m0001 },
  { version: 2, name: "games_index_seats_and_cluster", sql: m0002 },
  { version: 3, name: "games_live", sql: m0003 },
];

/** A lobby is listed for as long as a room keeps one; a running game for as long as its longest phase. */
const LISTING_TTL_MS = { lobby: 7 * 24 * 3600_000, active: 15 * 24 * 3600_000 } as const;

interface GameRow extends Record<string, SqlStorageValue> {
  game_id: string;
  result: string;
  reason: string | null;
  winners_json: string;
  scores_json: string;
  settings_json: string;
  cluster: string;
  phase_count: number;
  created_at: number;
  finished_at: number;
  ledger_json: string;
  seats_json: string;
}

interface LiveRow extends Record<string, SqlStorageValue> {
  game_id: string;
  status: string;
  settings_json: string;
  cluster: string;
  host_name: string | null;
  humans: number;
  open_seats: number;
  phase: string;
  deadline_at: number | null;
  created_at: number;
  updated_at: number;
}

function toListing(row: LiveRow): GameListing {
  return {
    gameId: row.game_id,
    status: row.status as GameListing["status"],
    settings: JSON.parse(row.settings_json) as GameListing["settings"],
    cluster: row.cluster,
    hostName: row.host_name,
    humans: row.humans,
    openSeats: row.open_seats,
    phase: row.phase,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRecord(row: GameRow): GameRecord {
  return {
    gameId: row.game_id,
    result: row.result as GameRecord["result"],
    reason: row.reason,
    winners: JSON.parse(row.winners_json) as GameRecord["winners"],
    scores: JSON.parse(row.scores_json) as GameRecord["scores"],
    settings: JSON.parse(row.settings_json) as GameRecord["settings"],
    cluster: row.cluster,
    phaseCount: row.phase_count,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    ledger: JSON.parse(row.ledger_json) as GameRecord["ledger"],
    seats: JSON.parse(row.seats_json) as GameRecord["seats"],
  };
}

export class Registry extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  /** Apply every migration newer than the stored version, each in its own transaction. */
  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
    const current = this.schemaVersion();
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(migration.sql);
        this.sql.exec(
          "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
          migration.version,
          migration.name,
          Date.now(),
        );
      });
    }
  }

  /** Highest migration applied to this instance. */
  schemaVersion(): number {
    return this.sql.exec<{ v: number | null }>("SELECT MAX(version) AS v FROM _migrations").one().v ?? 0;
  }

  /**
   * Index a finished or abandoned game. Idempotent: a room retries until this resolves, so the
   * same record may arrive more than once and must leave one row.
   */
  recordGame(input: GameRecord): { ok: true } {
    const record = GameRecord.parse(input);
    this.sql.exec(
      `INSERT INTO games_index
         (game_id, result, reason, winners_json, scores_json, settings_json, cluster, phase_count, created_at, finished_at, ledger_json, seats_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET
         result = excluded.result, reason = excluded.reason, winners_json = excluded.winners_json,
         scores_json = excluded.scores_json, settings_json = excluded.settings_json, cluster = excluded.cluster,
         phase_count = excluded.phase_count, created_at = excluded.created_at, finished_at = excluded.finished_at,
         ledger_json = excluded.ledger_json, seats_json = excluded.seats_json`,
      record.gameId,
      record.result,
      record.reason,
      JSON.stringify(record.winners),
      JSON.stringify(record.scores),
      JSON.stringify(record.settings),
      record.cluster,
      record.phaseCount,
      record.createdAt,
      record.finishedAt,
      JSON.stringify(record.ledger),
      JSON.stringify(record.seats),
    );
    // A game that has ended is no longer open or running.
    this.sql.exec("DELETE FROM games_live WHERE game_id = ?", record.gameId);
    return { ok: true };
  }

  /** Insert or refresh the listing of a public game that is open or running. */
  upsertListing(input: GameListing): { ok: true } {
    const listing = GameListing.parse(input);
    // A late refresh must never resurrect a game that has already been recorded as ended.
    if (this.getGame(listing.gameId)) return { ok: true };
    this.sql.exec(
      `INSERT INTO games_live
         (game_id, status, settings_json, cluster, host_name, humans, open_seats, phase, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id) DO UPDATE SET
         status = excluded.status, settings_json = excluded.settings_json, cluster = excluded.cluster,
         host_name = excluded.host_name, humans = excluded.humans, open_seats = excluded.open_seats,
         phase = excluded.phase, deadline_at = excluded.deadline_at, updated_at = excluded.updated_at`,
      listing.gameId,
      listing.status,
      JSON.stringify(listing.settings),
      listing.cluster,
      listing.hostName,
      listing.humans,
      listing.openSeats,
      listing.phase,
      listing.deadlineAt,
      listing.createdAt,
      listing.updatedAt,
    );
    return { ok: true };
  }

  removeListing(gameId: string): { ok: true } {
    this.sql.exec("DELETE FROM games_live WHERE game_id = ?", gameId);
    return { ok: true };
  }

  /**
   * Public games to join (`open`) or to watch (`active`), newest first. Rows a room stopped
   * refreshing long ago are left out, so a room that died without saying so never lingers.
   */
  listListings(options: { status: "open" | "active"; limit?: number; before?: number; now: number }): GameListing[] {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const rows =
      options.status === "open"
        ? this.sql.exec<LiveRow>(
            "SELECT * FROM games_live WHERE status = 'lobby' AND open_seats > 0 AND updated_at > ? AND created_at < ? ORDER BY created_at DESC, game_id LIMIT ?",
            options.now - LISTING_TTL_MS.lobby,
            before,
            limit,
          )
        : this.sql.exec<LiveRow>(
            "SELECT * FROM games_live WHERE status IN ('active', 'paused') AND updated_at > ? AND created_at < ? ORDER BY created_at DESC, game_id LIMIT ?",
            options.now - LISTING_TTL_MS.active,
            before,
            limit,
          );
    return rows.toArray().map(toListing);
  }

  getGame(gameId: string): GameRecord | null {
    const row = this.sql.exec<GameRow>("SELECT * FROM games_index WHERE game_id = ?", gameId).toArray()[0];
    return row ? toRecord(row) : null;
  }

  /** Most recently ended games first. `before` pages by `finishedAt`. */
  listGames(options: { limit?: number; before?: number; result?: GameRecord["result"] } = {}): GameRecord[] {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const rows = options.result
      ? this.sql.exec<GameRow>(
          "SELECT * FROM games_index WHERE finished_at < ? AND result = ? ORDER BY finished_at DESC, game_id LIMIT ?",
          before,
          options.result,
          limit,
        )
      : this.sql.exec<GameRow>(
          "SELECT * FROM games_index WHERE finished_at < ? ORDER BY finished_at DESC, game_id LIMIT ?",
          before,
          limit,
        );
    return rows.toArray().map(toRecord);
  }
}

/**
 * Registry: the one global index of games, a singleton SQLite-backed Durable Object
 * (`env.REGISTRY`, `idFromName("global")`).
 *
 * Game rooms hand their final summary here over RPC when a game is finished or abandoned. The
 * schema lives in the numbered migrations below and is brought up to date in the constructor, so
 * a deploy never needs a separate migration step. Add a migration; never edit one that has shipped.
 */
import { DurableObject } from "cloudflare:workers";
import { GameRecord } from "@cabal/protocol";
import type { Env } from "./env.js";

/** Name of the singleton instance. */
export const REGISTRY_NAME = "global";

export const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "games_index",
    // Justin Obomeghie's cross-game index from PR #68, moved here from D1. The result set also
    // admits `abandoned`, so games that died are indexed alongside games that ended.
    sql: `
      CREATE TABLE IF NOT EXISTS games_index (
        game_id TEXT PRIMARY KEY,
        result TEXT NOT NULL CHECK (result IN ('solo', 'draw', 'abandoned')),
        winners_json TEXT NOT NULL,
        scores_json TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        phase_count INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        ledger_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS games_index_finished_at ON games_index(finished_at DESC);
    `,
  },
  {
    version: 2,
    name: "games_index_seats_and_cluster",
    sql: `
      ALTER TABLE games_index ADD COLUMN reason TEXT;
      ALTER TABLE games_index ADD COLUMN cluster TEXT NOT NULL DEFAULT 'standard:full:async';
      ALTER TABLE games_index ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE games_index ADD COLUMN seats_json TEXT NOT NULL DEFAULT '[]';
      CREATE INDEX IF NOT EXISTS games_index_cluster ON games_index(cluster, finished_at DESC);
    `,
  },
];

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
    return { ok: true };
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

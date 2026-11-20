/**
 * The D1 adapter for the cross-game index (database `cabal`, binding `DB`).
 *
 * It implements two ports: `GameIndex` (finished games, public listings, the seats signed-in
 * players hold) and `PlayerStore` (guest accounts, ratings, reliability and the trust ledger). The
 * schema is the numbered SQL files in `migrations/`, applied by `wrangler d1 migrations apply`.
 *
 * Correctness without a single writer:
 *
 *  - Every multi-row change is one `batch`, which D1 runs as one transaction.
 *  - Recording a game is idempotent (upserts, then totals recomputed from rows in one statement),
 *    so a room's outbox may retry it any number of times.
 *  - A game is rated at most once: the rating batch starts by inserting the game into
 *    `rated_games`, so a replay fails on its primary key and rolls back.
 *  - Two games ending at once for the same player cannot lose an update: the batch re-checks each
 *    player's rating count (compare-and-swap through `batch_guard`) and is retried on a conflict.
 *
 * The deployment-wide Claude budget stays in the Registry Durable Object, where admission is one
 * synchronous step in one object; this adapter hands those two calls to it.
 */
import {
  type GameListing,
  GameListing as GameListingSchema,
  type GameRecord,
  GameRecord as GameRecordSchema,
  type LeaderboardResponse,
  type MeResponse,
  type MyGame,
  type PlayerProfile,
  type PlayerResult,
  type PlayerSession,
  type PlayerSummary,
  type RatingHistoryResponse,
  type RatingView,
  type TrustLeaderboardResponse,
} from "@cabal/protocol";
import type { GameIndex, ListFinished, ListLive, SeatClaim } from "./game-index.js";
import { ALIAS_HOLD_MS, HANDLE_PROBLEMS, RENAME_COOLDOWN_MS, handleKey, handleProblem, pickHandle } from "./handles.js";
import {
  LADDER,
  RATING_RULES,
  RELIABILITY_SQL,
  TRUST_SQL,
  conservative,
  countsForTrust,
  decayed,
  rateGame,
  ratedGame,
  reliability,
  trust,
} from "./ratings.js";
import { forgetInModeration } from "./moderation.js";
import { fullGameEvent } from "./metrics.js";
import type { Registry } from "./registry.js";
import { hashRecoveryCode, hashToken, mintPlayerId, mintPlayerSecret, mintRecoveryCode, normaliseRecoveryCode } from "./tokens.js";

/** Lobby and running listings go stale after these long without a refresh (as in the Registry). */
const LISTING_TTL_MS = { lobby: 7 * 24 * 3600_000, active: 15 * 24 * 3600_000 } as const;
/** A player drops off the leaderboard after this long without a rated game. */
export const LEADERBOARD_ACTIVE_MS = 180 * 24 * 3600_000;
/** The trust ledger lists players with at least this many kept or broken pledges. */
export const LEDGER_MIN_PLEDGES = 3;
/** Devices one account may be signed in on; the oldest session makes way. */
export const SESSIONS_PER_PLAYER = 10;
/** A session's last use is written at most this often, so reads do not become writes. */
const SEEN_EVERY_MS = 3600_000;
/** Recent results on a profile, and games in a player's own list. */
const RECENT_RESULTS = 20;
const MY_GAMES = 100;
/** Rated games in one rating history answer: the default and the most a caller may ask for. */
export const HISTORY_POINTS = { fallback: 50, max: 200 } as const;
/** The name a deleted player's seat goes by in the index, as in the room (room.ts `GHOST_NAME`). */
const GHOST = "Ghost";

export type RenameOutcome =
  | { ok: true }
  | { ok: false; status: number; code: "handle_shape" | "handle_reserved" | "handle_abusive" | "handle_taken" | "rename_cooldown"; message: string; retryAt?: number };

/** The port for players: accounts, sessions, profiles and boards. */
export interface PlayerStore {
  createPlayer(handle: string | null, now: number): Promise<PlayerSession | RenameOutcome>;
  /** The player a bearer secret belongs to, or null. Notes the session's use. */
  authenticate(secret: string, now: number): Promise<PlayerSummary | null>;
  /** A new device session from a recovery code, or null when the code is not valid. */
  recover(code: string, now: number): Promise<PlayerSession | null>;
  issueRecoveryCode(playerId: string, now: number): Promise<{ recoveryCode: string; issuedAt: number }>;
  rename(playerId: string, handle: string, now: number): Promise<RenameOutcome>;
  logout(secret: string, everywhere: boolean): Promise<void>;
  profile(handle: string, now: number): Promise<PlayerProfile | null>;
  me(playerId: string, now: number): Promise<MeResponse | null>;
  myGames(playerId: string): Promise<MyGame[]>;
  leaderboard(page: { offset: number; limit: number; now: number }): Promise<LeaderboardResponse>;
  trustBoard(page: { offset: number; limit: number }): Promise<TrustLeaderboardResponse>;
  /** The rating after each of the player's most recent rated games, oldest first; null for no such player. */
  ratingHistory(handle: string, now: number, limit?: number): Promise<RatingHistoryResponse | null>;
  /** Every game the player holds or held a seat in, as the index knows it. */
  gamesOf(playerId: string): Promise<string[]>;
  /**
   * Delete the player for good: the account, its sessions, devices, rating, history, totals and
   * switches go; their seats in the index stay as anonymous ghosts so other players' records and
   * every finished game still add up; their id goes from other players' rating breakdowns. In the
   * `unplayed` games (lobbies whose room has already reopened their seat) their rows go outright,
   * because the room keeps no stint of theirs there. Idempotent.
   */
  deletePlayer(playerId: string, unplayed?: readonly string[]): Promise<void>;
}

interface PlayerRow {
  id: string;
  handle: string;
  created_at: number;
  handle_changed_at: number | null;
  recovery_issued_at: number | null;
}

interface RatingRow {
  player_id: string;
  rating: number;
  rd: number;
  volatility: number;
  games: number;
  conservative: number;
  last_game_at: number;
}

interface StatsRow {
  games: number;
  completed: number;
  walked_out: number;
  solos: number;
  draws: number;
  phases_due: number;
  phases_on_time: number;
  phases_late: number;
  kept: number;
  broken: number;
  void: number;
  reliability: number;
  trust: number;
}

interface GameRow {
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

interface LiveRow {
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

const clampLimit = (limit: number | undefined, max = 100, fallback = 25) => Math.max(1, Math.min(max, Math.floor(Number.isFinite(limit) ? limit! : fallback)));
/** Pages start no further in than this: deeper than any board needs, and always a bindable integer. */
export const MAX_OFFSET = 10_000;
/** A paging offset D1 can bind: a whole number from 0 to `MAX_OFFSET`, else 0 (NaN, Infinity, 1e300, -3). */
export const clampOffset = (offset: number | undefined) => {
  const n = Math.floor(offset ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, MAX_OFFSET) : 0;
};
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");
const summaryOf = (row: Pick<PlayerRow, "id" | "handle" | "created_at">): PlayerSummary => ({ id: row.id, handle: row.handle, createdAt: row.created_at });
const isConstraint = (error: unknown, what: string) => String(error instanceof Error ? error.message : error).includes(what);

const UPSERT_GAME = `INSERT INTO games_index
   (game_id, result, reason, winners_json, scores_json, settings_json, cluster, phase_count, created_at, finished_at, ledger_json, seats_json, public)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Recompute one player's totals from their game rows. One statement, so it is always consistent. */
const RECOMPUTE_STATS = `INSERT INTO player_stats
   (player_id, games, completed, walked_out, solos, draws, phases_due, phases_on_time, phases_late, kept, broken, void, reliability, trust, updated_at)
 SELECT player_id, COUNT(*),
   SUM(CASE WHEN left_reason IS NULL AND civil_disorder = 0 THEN 1 ELSE 0 END),
   SUM(CASE WHEN left_reason IS NOT NULL OR civil_disorder = 1 THEN 1 ELSE 0 END),
   SUM(CASE WHEN result = 'solo' AND score >= 1 THEN 1 ELSE 0 END),
   SUM(CASE WHEN result = 'draw' AND score > 0 THEN 1 ELSE 0 END),
   SUM(phases_due), SUM(phases_on_time), SUM(phases_late), SUM(kept), SUM(broken), SUM(void),
   ${RELIABILITY_SQL("SUM(phases_on_time)", "SUM(phases_late)", "SUM(phases_due)", "SUM(CASE WHEN left_reason IS NOT NULL OR civil_disorder = 1 THEN 1 ELSE 0 END)")},
   ${TRUST_SQL("SUM(kept)", "SUM(broken)")},
   ?
 FROM game_players
 WHERE player_id = ? AND status IN ('finished', 'abandoned') AND EXISTS (SELECT 1 FROM players WHERE id = ?)
 GROUP BY player_id
 ON CONFLICT(player_id) DO UPDATE SET
   games = excluded.games, completed = excluded.completed, walked_out = excluded.walked_out, solos = excluded.solos,
   draws = excluded.draws, phases_due = excluded.phases_due, phases_on_time = excluded.phases_on_time,
   phases_late = excluded.phases_late, kept = excluded.kept, broken = excluded.broken, void = excluded.void,
   reliability = excluded.reliability, trust = excluded.trust, updated_at = excluded.updated_at`;

export class D1Index implements GameIndex, PlayerStore {
  constructor(
    private readonly db: D1Database,
    /** The Registry, for the Claude budget. Absent in bare setups: every Claude game is then refused. */
    private readonly registry: (() => DurableObjectStub<Registry>) | null,
  ) {}

  // ---------- GameIndex: finished games ----------

  async recordGame(input: GameRecord): Promise<void> {
    const record = await this.withoutDeparted(GameRecordSchema.parse(input));
    const now = Date.now();
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `${UPSERT_GAME}
           ON CONFLICT(game_id) DO UPDATE SET
             result = excluded.result, reason = excluded.reason, winners_json = excluded.winners_json,
             scores_json = excluded.scores_json, settings_json = excluded.settings_json, cluster = excluded.cluster,
             phase_count = excluded.phase_count, created_at = excluded.created_at, finished_at = excluded.finished_at,
             ledger_json = excluded.ledger_json, seats_json = excluded.seats_json, public = excluded.public`,
        )
        .bind(...gameRow(record)),
      // A game that has ended is no longer open or running.
      this.db.prepare("DELETE FROM games_live WHERE game_id = ?").bind(record.gameId),
    ];
    const status = record.phaseCount === 0 ? "void" : record.result === "abandoned" ? "abandoned" : "finished";
    // Pledges count towards a player's trust ledger only from a game that meets the rated bar.
    const trusted = countsForTrust(record);
    const seats = new Map(record.seats.map((s) => [s.power, s]));
    for (const p of record.players ?? []) {
      const seat = seats.get(p.power);
      const lasted = p.leftReason === null;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO game_players
               (game_id, power, stint, player_id, kind, name, joined_at, substitute, status, left_reason, result, score, centers,
                eliminated, civil_disorder, phases_due, phases_on_time, phases_late, kept, broken, void, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(game_id, power, stint) DO UPDATE SET
               player_id = excluded.player_id, kind = excluded.kind, name = excluded.name, joined_at = excluded.joined_at,
               substitute = excluded.substitute, status = excluded.status, left_reason = excluded.left_reason,
               result = excluded.result, score = excluded.score, centers = excluded.centers, eliminated = excluded.eliminated,
               civil_disorder = excluded.civil_disorder, phases_due = excluded.phases_due, phases_on_time = excluded.phases_on_time,
               phases_late = excluded.phases_late, kept = excluded.kept, broken = excluded.broken, void = excluded.void,
               finished_at = excluded.finished_at`,
          )
          .bind(
            record.gameId,
            p.power,
            p.stint,
            p.playerId,
            p.kind,
            p.name,
            p.joinedAt,
            p.substitute ? 1 : 0,
            status,
            p.leftReason,
            record.result,
            lasted ? (record.scores[p.power] ?? 0) : 0,
            seat?.centers ?? 0,
            seat?.eliminated ? 1 : 0,
            p.civilDisorder ? 1 : 0,
            p.phasesDue,
            p.phasesOnTime,
            p.phasesLate,
            trusted ? p.ledger.kept : 0,
            trusted ? p.ledger.broken : 0,
            trusted ? p.ledger.void : 0,
            record.finishedAt,
          ),
      );
    }
    const players = [...new Set((record.players ?? []).map((p) => p.playerId).filter((id): id is string => id !== null))];
    for (const id of players) statements.push(this.db.prepare(RECOMPUTE_STATS).bind(now, id, id));
    // The phase 1 metric "a full game completes", once per game however often this is retried.
    const metric = fullGameEvent(this.db, record);
    if (metric) statements.push(metric);
    await this.db.batch(statements);
    await this.rate(record);
  }

  /**
   * A record can name a player who has since deleted their account (the room could not be told, or
   * its hand-off was already on its way): that stint is kept, as an anonymous ghost, never tied to
   * an id the index no longer knows.
   */
  private async withoutDeparted(record: GameRecord): Promise<GameRecord> {
    const ids = [...new Set((record.players ?? []).map((p) => p.playerId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return record;
    const known = new Set(
      (await this.db.prepare(`SELECT id FROM players WHERE id IN (${placeholders(ids.length)})`).bind(...ids).all<{ id: string }>()).results.map((r) => r.id),
    );
    if (known.size === ids.length) return record;
    const gone = new Set(record.players!.filter((p) => p.playerId !== null && !known.has(p.playerId) && p.leftReason === null).map((p) => p.power));
    return {
      ...record,
      seats: record.seats.map((s) => (gone.has(s.power) ? { ...s, name: GHOST } : s)),
      players: record.players!.map((p) => (p.playerId !== null && !known.has(p.playerId) ? { ...p, playerId: null, name: GHOST } : p)),
    };
  }

  /** Fold a rated game into its players' ratings, at most once. */
  private async rate(record: GameRecord): Promise<void> {
    const rated = ratedGame(record);
    if (!rated.rated) return;
    if (await this.db.prepare("SELECT 1 AS x FROM rated_games WHERE game_id = ?").bind(record.gameId).first()) return;
    const ids = [...new Set(rated.participants.map((p) => p.playerId))];
    const known = new Set(
      (await this.db.prepare(`SELECT id FROM players WHERE id IN (${placeholders(ids.length)})`).bind(...ids).all<{ id: string }>()).results.map((r) => r.id),
    );
    // A record naming a player the index has never seen (it cannot happen through the router) rates nobody.
    if (known.size !== ids.length) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      const rows = (
        await this.db
          .prepare(`SELECT * FROM ratings WHERE ladder = ? AND player_id IN (${placeholders(ids.length)})`)
          .bind(LADDER, ...ids)
          .all<RatingRow>()
      ).results;
      const byId = new Map(rows.map((r) => [r.player_id, r]));
      const current = new Map(rows.map((r) => [r.player_id, decayed(r, r.last_game_at, record.finishedAt)]));
      const changes = rateGame(rated.participants, current);
      const statements: D1PreparedStatement[] = [
        this.db.prepare("INSERT INTO rated_games (game_id, ladder, players, rated_at) VALUES (?, ?, ?, ?)").bind(record.gameId, LADDER, ids.length, Date.now()),
        // Compare-and-swap: if anyone's rating moved since it was read, inserting NULL fails the batch.
        ...ids.map((id) =>
          this.db
            .prepare("INSERT INTO batch_guard (ok) SELECT NULL WHERE COALESCE((SELECT games FROM ratings WHERE player_id = ? AND ladder = ?), -1) <> ?")
            .bind(id, LADDER, byId.get(id)?.games ?? -1),
        ),
      ];
      for (const change of changes) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO ratings (player_id, ladder, rating, rd, volatility, games, conservative, last_game_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?)
               ON CONFLICT(player_id, ladder) DO UPDATE SET
                 rating = excluded.rating, rd = excluded.rd, volatility = excluded.volatility, games = ratings.games + 1,
                 conservative = excluded.conservative, last_game_at = MAX(ratings.last_game_at, excluded.last_game_at)`,
            )
            .bind(change.playerId, LADDER, change.after.rating, change.after.rd, change.after.volatility, conservative(change.after), record.finishedAt),
          this.db
            .prepare(
              `INSERT INTO rating_history (player_id, ladder, game_id, rating_before, rd_before, rating_after, rd_after, opponents_json, at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              change.playerId,
              LADDER,
              record.gameId,
              change.before.rating,
              change.before.rd,
              change.after.rating,
              change.after.rd,
              JSON.stringify(change.opponents),
              record.finishedAt,
            ),
        );
      }
      try {
        await this.db.batch(statements);
        return;
      } catch (error) {
        if (isConstraint(error, "rated_games")) return; // rated already, by a retry that got there first
        if (isConstraint(error, "batch_guard")) continue; // someone's rating moved: read again
        throw error;
      }
    }
    throw new Error(`could not rate ${record.gameId}: ratings kept changing`);
  }

  async getGame(gameId: string): Promise<GameRecord | null> {
    const row = await this.db.prepare("SELECT * FROM games_index WHERE game_id = ?").bind(gameId).first<GameRow>();
    return row ? toRecord(row) : null;
  }

  async listGames(options: ListFinished = {}): Promise<GameRecord[]> {
    const limit = clampLimit(options.limit);
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const query = options.result
      ? this.db
          .prepare("SELECT * FROM games_index WHERE public = 1 AND phase_count > 0 AND finished_at < ? AND result = ? ORDER BY finished_at DESC, game_id LIMIT ?")
          .bind(before, options.result, limit)
      : this.db.prepare("SELECT * FROM games_index WHERE public = 1 AND phase_count > 0 AND finished_at < ? ORDER BY finished_at DESC, game_id LIMIT ?").bind(before, limit);
    return (await query.all<GameRow>()).results.map(toRecord);
  }

  // ---------- GameIndex: live listings ----------

  async upsertListing(input: GameListing): Promise<void> {
    const listing = GameListingSchema.parse(input);
    // One statement: a late refresh can never resurrect a game already recorded as ended.
    await this.db
      .prepare(
        `INSERT INTO games_live
           (game_id, status, settings_json, cluster, host_name, humans, open_seats, phase, deadline_at, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM games_index WHERE game_id = ?)
         ON CONFLICT(game_id) DO UPDATE SET
           status = excluded.status, settings_json = excluded.settings_json, cluster = excluded.cluster,
           host_name = excluded.host_name, humans = excluded.humans, open_seats = excluded.open_seats,
           phase = excluded.phase, deadline_at = excluded.deadline_at, updated_at = excluded.updated_at`,
      )
      .bind(
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
        listing.gameId,
      )
      .run();
  }

  async removeListing(gameId: string): Promise<void> {
    await this.db.prepare("DELETE FROM games_live WHERE game_id = ?").bind(gameId).run();
  }

  async listListings(options: ListLive): Promise<GameListing[]> {
    const limit = clampLimit(options.limit);
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const query =
      options.status === "open"
        ? this.db
            .prepare("SELECT * FROM games_live WHERE status = 'lobby' AND open_seats > 0 AND updated_at > ? AND created_at < ? ORDER BY created_at DESC, game_id LIMIT ?")
            .bind(options.now - LISTING_TTL_MS.lobby, before, limit)
        : this.db
            .prepare("SELECT * FROM games_live WHERE status IN ('active', 'paused') AND updated_at > ? AND created_at < ? ORDER BY created_at DESC, game_id LIMIT ?")
            .bind(options.now - LISTING_TTL_MS.active, before, limit);
    return (await query.all<LiveRow>()).results.map(toListing);
  }

  // ---------- GameIndex: seats held by signed-in players ----------

  async recordSeat(claim: SeatClaim): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO game_players (game_id, power, stint, player_id, kind, name, joined_at, substitute, status)
           VALUES (?, ?, ?, ?, 'human', ?, ?, ?, 'playing')
           ON CONFLICT(game_id, power, stint) DO NOTHING`,
        )
        .bind(claim.gameId, claim.power, claim.stint, claim.playerId, claim.name, claim.joinedAt, claim.substitute ? 1 : 0),
      // Whoever held the seat before a substitute has left it.
      this.db
        .prepare("UPDATE game_players SET left_reason = 'replaced' WHERE game_id = ? AND power = ? AND stint < ? AND left_reason IS NULL")
        .bind(claim.gameId, claim.power, claim.stint),
    ]);
  }

  async schemaVersion(): Promise<number> {
    const row = await this.db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>();
    return row ? Number.parseInt(row.name, 10) || 0 : 0;
  }

  // ---------- GameIndex: the Claude budget, kept by the Registry ----------

  async admitClaudeGame(request: { gameId: string; capMicros: number; now: number }): Promise<{ admitted: boolean; reason: string | null }> {
    if (!this.registry) return { admitted: false, reason: "no_budget_authority" };
    return this.registry().admitClaudeGame(request);
  }

  async releaseClaudeGame(request: { gameId: string; spentMicros: number; now: number }): Promise<void> {
    if (this.registry) await this.registry().releaseClaudeGame(request);
  }

  // ---------- the one-time copy from the Registry ----------

  /**
   * Copy every games index row and live listing the Registry holds, once. Idempotent: rows already
   * in D1 are kept as they are (they are newer), and the copy is marked done only when it finished.
   * Returns how many rows were copied, or null when the copy had already been made.
   */
  async copyFromRegistry(registry: DurableObjectStub<Registry>): Promise<{ games: number; listings: number } | null> {
    if (await this.db.prepare("SELECT 1 AS x FROM index_meta WHERE key = 'registry_copy'").first()) return null;
    let games = 0;
    let after = "";
    for (;;) {
      const page = (await registry.exportGames(after, 50)) as GameRecord[];
      if (page.length === 0) break;
      await this.db.batch(page.map((record) => this.db.prepare(`${UPSERT_GAME} ON CONFLICT(game_id) DO NOTHING`).bind(...gameRow(record))));
      games += page.length;
      after = page.at(-1)!.gameId;
    }
    const listings = (await registry.exportListings()) as GameListing[];
    for (let i = 0; i < listings.length; i += 50) {
      await this.db.batch(
        listings.slice(i, i + 50).map((l) =>
          this.db
            .prepare(
              `INSERT INTO games_live (game_id, status, settings_json, cluster, host_name, humans, open_seats, phase, deadline_at, created_at, updated_at)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM games_index WHERE game_id = ?)
               ON CONFLICT(game_id) DO NOTHING`,
            )
            .bind(l.gameId, l.status, JSON.stringify(l.settings), l.cluster, l.hostName, l.humans, l.openSeats, l.phase, l.deadlineAt, l.createdAt, l.updatedAt, l.gameId),
        ),
      );
    }
    await this.db
      .prepare("INSERT INTO index_meta (key, value, updated_at) VALUES ('registry_copy', ?, ?) ON CONFLICT(key) DO NOTHING")
      .bind(JSON.stringify({ games, listings: listings.length }), Date.now())
      .run();
    return { games, listings: listings.length };
  }

  // ---------- PlayerStore: accounts and sessions ----------

  async createPlayer(chosen: string | null, now: number): Promise<PlayerSession | RenameOutcome> {
    if (chosen !== null) {
      const problem = handleRefusal(chosen);
      if (problem) return problem;
    }
    // A picked name may collide; try a few before giving up.
    for (let attempt = 0; attempt < (chosen === null ? 8 : 1); attempt++) {
      const handle = chosen ?? pickHandle();
      const id = mintPlayerId();
      const secret = mintPlayerSecret();
      const key = handleKey(handle);
      try {
        const [inserted] = await this.db.batch([
          this.db
            .prepare(
              `INSERT INTO players (id, handle, handle_key, created_at, last_seen_at)
               SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM handle_aliases WHERE handle_key = ? AND until > ?)`,
            )
            .bind(id, handle.trim(), key, now, now, key, now),
          this.db
            .prepare("INSERT INTO player_sessions (secret_hash, player_id, created_at, last_used_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM players WHERE id = ?)")
            .bind(hashToken(secret), id, now, now, id),
        ]);
        if ((inserted?.meta.changes ?? 0) === 0) {
          if (chosen !== null) return taken();
          continue;
        }
        return { player: { id, handle: handle.trim(), createdAt: now }, secret };
      } catch (error) {
        if (!isConstraint(error, "players.handle_key")) throw error;
        if (chosen !== null) return taken();
      }
    }
    return taken();
  }

  async authenticate(secret: string, now: number): Promise<PlayerSummary | null> {
    const hash = hashToken(secret);
    const row = await this.db
      .prepare("SELECT p.id, p.handle, p.created_at, s.last_used_at FROM player_sessions s JOIN players p ON p.id = s.player_id WHERE s.secret_hash = ?")
      .bind(hash)
      .first<PlayerRow & { last_used_at: number }>();
    if (!row) return null;
    if (now - row.last_used_at > SEEN_EVERY_MS) {
      await this.db.batch([
        this.db.prepare("UPDATE player_sessions SET last_used_at = ? WHERE secret_hash = ?").bind(now, hash),
        this.db.prepare("UPDATE players SET last_seen_at = ? WHERE id = ?").bind(now, row.id),
      ]);
    }
    return summaryOf(row);
  }

  private async openSession(playerId: string, now: number): Promise<string> {
    const secret = mintPlayerSecret();
    await this.db.batch([
      this.db.prepare("INSERT INTO player_sessions (secret_hash, player_id, created_at, last_used_at) VALUES (?, ?, ?, ?)").bind(hashToken(secret), playerId, now, now),
      // The oldest devices make way past the cap.
      this.db
        .prepare(
          `DELETE FROM player_sessions WHERE player_id = ? AND secret_hash NOT IN
             (SELECT secret_hash FROM player_sessions WHERE player_id = ? ORDER BY created_at DESC, secret_hash LIMIT ?)`,
        )
        .bind(playerId, playerId, SESSIONS_PER_PLAYER),
    ]);
    return secret;
  }

  async recover(code: string, now: number): Promise<PlayerSession | null> {
    const body = normaliseRecoveryCode(code);
    if (!body) return null;
    const row = await this.db.prepare("SELECT id, handle, created_at FROM players WHERE recovery_hash = ?").bind(hashRecoveryCode(body)).first<PlayerRow>();
    if (!row) return null;
    const secret = await this.openSession(row.id, now);
    await this.db.prepare("UPDATE players SET last_seen_at = ? WHERE id = ?").bind(now, row.id).run();
    return { player: summaryOf(row), secret };
  }

  async issueRecoveryCode(playerId: string, now: number): Promise<{ recoveryCode: string; issuedAt: number }> {
    const recoveryCode = mintRecoveryCode();
    await this.db
      .prepare("UPDATE players SET recovery_hash = ?, recovery_issued_at = ? WHERE id = ?")
      .bind(hashRecoveryCode(normaliseRecoveryCode(recoveryCode)!), now, playerId)
      .run();
    return { recoveryCode, issuedAt: now };
  }

  async rename(playerId: string, handle: string, now: number): Promise<RenameOutcome> {
    const problem = handleRefusal(handle);
    if (problem) return problem;
    const row = await this.db.prepare("SELECT * FROM players WHERE id = ?").bind(playerId).first<PlayerRow & { handle_key: string }>();
    if (!row) return { ok: false, status: 404, code: "handle_taken", message: "no such player" };
    const key = handleKey(handle);
    // Changing only how one's own handle is written (its case, `_` for `-`) is always allowed and costs nothing.
    if (key === row.handle_key) {
      await this.db.prepare("UPDATE players SET handle = ? WHERE id = ?").bind(handle.trim(), playerId).run();
      return { ok: true };
    }
    const retryAt = row.handle_changed_at === null ? null : row.handle_changed_at + RENAME_COOLDOWN_MS;
    if (retryAt !== null && now < retryAt) {
      return { ok: false, status: 429, code: "rename_cooldown", message: "a handle can be changed once every 14 days", retryAt };
    }
    try {
      const [updated] = await this.db.batch([
        this.db
          .prepare(
            `UPDATE players SET handle = ?, handle_key = ?, handle_changed_at = ?
             WHERE id = ? AND NOT EXISTS (SELECT 1 FROM handle_aliases WHERE handle_key = ? AND until > ? AND player_id <> ?)`,
          )
          .bind(handle.trim(), key, now, playerId, key, now, playerId),
        // The old handle stays this player's for a while; the new one is no longer an alias of anyone.
        this.db
          .prepare(
            `INSERT INTO handle_aliases (handle_key, player_id, until) SELECT ?, ?, ? WHERE changes() > 0
             ON CONFLICT(handle_key) DO UPDATE SET player_id = excluded.player_id, until = excluded.until`,
          )
          .bind(row.handle_key, playerId, now + ALIAS_HOLD_MS),
        this.db.prepare("DELETE FROM handle_aliases WHERE handle_key = ? AND player_id = ?").bind(key, playerId),
      ]);
      if ((updated?.meta.changes ?? 0) === 0) return taken();
      return { ok: true };
    } catch (error) {
      if (isConstraint(error, "players.handle_key")) return taken();
      throw error;
    }
  }

  async logout(secret: string, everywhere: boolean): Promise<void> {
    const hash = hashToken(secret);
    if (everywhere) {
      await this.db.prepare("DELETE FROM player_sessions WHERE player_id = (SELECT player_id FROM player_sessions WHERE secret_hash = ?)").bind(hash).run();
    } else {
      await this.db.prepare("DELETE FROM player_sessions WHERE secret_hash = ?").bind(hash).run();
    }
  }

  // ---------- PlayerStore: profiles and boards ----------

  private async playerByHandle(handle: string, now: number): Promise<PlayerRow | null> {
    const key = handleKey(handle);
    return (
      (await this.db.prepare("SELECT * FROM players WHERE handle_key = ?").bind(key).first<PlayerRow>()) ??
      (await this.db
        .prepare("SELECT p.* FROM handle_aliases a JOIN players p ON p.id = a.player_id WHERE a.handle_key = ? AND a.until > ?")
        .bind(key, now)
        .first<PlayerRow>())
    );
  }

  private async buildProfile(row: PlayerRow, now: number, own: boolean): Promise<PlayerProfile> {
    const [ratingRow, stats, recent] = await this.db.batch([
      this.db.prepare("SELECT * FROM ratings WHERE player_id = ? AND ladder = ?").bind(row.id, LADDER),
      this.db.prepare("SELECT * FROM player_stats WHERE player_id = ?").bind(row.id),
      this.db
        .prepare(
          `SELECT gp.game_id, gp.power, gp.result, gp.score, gp.centers, gp.substitute, gp.left_reason, gp.civil_disorder, gp.finished_at,
                  g.public, h.rating_after - h.rating_before AS delta
           FROM game_players gp
           LEFT JOIN games_index g ON g.game_id = gp.game_id
           LEFT JOIN rating_history h ON h.player_id = gp.player_id AND h.game_id = gp.game_id AND h.ladder = ?
           WHERE gp.player_id = ? AND gp.status IN ('finished', 'abandoned') ${own ? "" : "AND g.public = 1"}
           ORDER BY gp.finished_at DESC LIMIT ?`,
        )
        .bind(LADDER, row.id, RECENT_RESULTS),
    ]);
    const r = (ratingRow?.results[0] as RatingRow | undefined) ?? null;
    const s = (stats?.results[0] as StatsRow | undefined) ?? null;
    let rating: RatingView | null = null;
    if (r) {
      const isEstablished = r.games >= RATING_RULES.establishedGames && r.rd <= RATING_RULES.establishedRd && r.last_game_at > now - LEADERBOARD_ACTIVE_MS;
      const ahead = isEstablished
        ? ((await this.db
            // `conservative >= ?` as a plain range, so the count reads the board index from this
            // player up rather than every rating on the ladder; the tie-break is a residual filter.
            .prepare("SELECT COUNT(*) AS n FROM ratings WHERE ladder = ? AND conservative >= ? AND games >= ? AND rd <= ? AND last_game_at > ? AND (conservative > ? OR player_id < ?)")
            .bind(LADDER, r.conservative, RATING_RULES.establishedGames, RATING_RULES.establishedRd, now - LEADERBOARD_ACTIVE_MS, r.conservative, r.player_id)
            .first<{ n: number }>())?.n ?? 0)
        : 0;
      const grown = decayed(r, r.last_game_at, now);
      rating = {
        ladder: LADDER,
        rating: r.rating,
        rd: grown.rd,
        volatility: r.volatility,
        conservative: r.conservative,
        games: r.games,
        established: isEstablished,
        rank: isEstablished ? ahead + 1 : null,
        lastGameAt: r.last_game_at,
      };
    }
    const due = s?.phases_due ?? 0;
    const onTime = s?.phases_on_time ?? 0;
    const late = s?.phases_late ?? 0;
    const walkedOut = s?.walked_out ?? 0;
    return {
      player: summaryOf(row),
      rating,
      reliability: {
        score: s?.reliability ?? reliability({ phasesDue: 0, phasesOnTime: 0, phasesLate: 0, gamesWalkedOut: 0 }),
        phasesDue: due,
        phasesOnTime: onTime,
        phasesLate: late,
        missed: Math.max(0, due - onTime - late),
        gamesCompleted: s?.completed ?? 0,
        gamesWalkedOut: walkedOut,
      },
      trust: { score: s?.trust ?? trust({ kept: 0, broken: 0 }), kept: s?.kept ?? 0, broken: s?.broken ?? 0, void: s?.void ?? 0 },
      games: { played: s?.games ?? 0, solos: s?.solos ?? 0, draws: s?.draws ?? 0 },
      recent: ((recent?.results ?? []) as RecentRow[]).map((g) => toResult(g, own)),
    };
  }

  async profile(handle: string, now: number): Promise<PlayerProfile | null> {
    const row = await this.playerByHandle(handle, now);
    return row ? this.buildProfile(row, now, false) : null;
  }

  async me(playerId: string, now: number): Promise<MeResponse | null> {
    const row = await this.db.prepare("SELECT * FROM players WHERE id = ?").bind(playerId).first<PlayerRow>();
    if (!row) return null;
    const profile = await this.buildProfile(row, now, true);
    const sessions = (await this.db.prepare("SELECT COUNT(*) AS n FROM player_sessions WHERE player_id = ?").bind(playerId).first<{ n: number }>())?.n ?? 0;
    const renameAt = row.handle_changed_at === null ? null : row.handle_changed_at + RENAME_COOLDOWN_MS;
    return {
      ...profile,
      account: { renameAvailableAt: renameAt !== null && renameAt > now ? renameAt : null, recoveryIssuedAt: row.recovery_issued_at, sessions },
    };
  }

  async myGames(playerId: string): Promise<MyGame[]> {
    const rows = (
      await this.db
        .prepare(
          `SELECT gp.*, h.rating_after - h.rating_before AS delta FROM game_players gp
           LEFT JOIN rating_history h ON h.player_id = gp.player_id AND h.game_id = gp.game_id AND h.ladder = ?
           WHERE gp.player_id = ? ORDER BY gp.joined_at DESC, gp.game_id LIMIT ?`,
        )
        .bind(LADDER, playerId, MY_GAMES)
        .all<{
          game_id: string;
          power: string;
          status: string;
          left_reason: string | null;
          joined_at: number;
          finished_at: number | null;
          result: string | null;
          score: number | null;
          centers: number | null;
          delta: number | null;
        }>()
    ).results;
    return rows.map((g) => ({
      gameId: g.game_id,
      power: g.power as MyGame["power"],
      status: g.status === "playing" ? (g.left_reason ? "left" : "playing") : g.status === "finished" ? "finished" : "abandoned",
      joinedAt: g.joined_at,
      finishedAt: g.finished_at,
      result: (g.result as MyGame["result"]) ?? null,
      score: g.score,
      centers: g.centers,
      ratingDelta: g.delta,
    }));
  }

  async leaderboard(page: { offset: number; limit: number; now: number }): Promise<LeaderboardResponse> {
    const limit = clampLimit(page.limit);
    const offset = clampOffset(page.offset);
    const rows = (
      await this.db
        .prepare(
          `SELECT r.*, p.handle, p.created_at FROM ratings r JOIN players p ON p.id = r.player_id
           WHERE r.ladder = ? AND r.games >= ? AND r.rd <= ? AND r.last_game_at > ?
           ORDER BY r.conservative DESC, r.player_id LIMIT ? OFFSET ?`,
        )
        .bind(LADDER, RATING_RULES.establishedGames, RATING_RULES.establishedRd, page.now - LEADERBOARD_ACTIVE_MS, limit + 1, offset)
        .all<RatingRow & { handle: string; created_at: number }>()
    ).results;
    return {
      ladder: LADDER,
      entries: rows.slice(0, limit).map((r, i) => ({
        rank: offset + i + 1,
        player: { id: r.player_id, handle: r.handle, createdAt: r.created_at },
        rating: r.rating,
        rd: r.rd,
        conservative: r.conservative,
        games: r.games,
        lastGameAt: r.last_game_at,
      })),
      offset,
      limit,
      next: rows.length > limit ? offset + limit : null,
    };
  }

  async trustBoard(page: { offset: number; limit: number }): Promise<TrustLeaderboardResponse> {
    const limit = clampLimit(page.limit);
    const offset = clampOffset(page.offset);
    const rows = (
      await this.db
        .prepare(
          `SELECT s.*, p.handle, p.created_at, p.id FROM player_stats s JOIN players p ON p.id = s.player_id
           WHERE s.kept + s.broken >= ? ORDER BY s.trust DESC, s.kept DESC, s.player_id LIMIT ? OFFSET ?`,
        )
        .bind(LEDGER_MIN_PLEDGES, limit + 1, offset)
        .all<StatsRow & { id: string; handle: string; created_at: number }>()
    ).results;
    return {
      entries: rows.slice(0, limit).map((r, i) => ({
        rank: offset + i + 1,
        player: summaryOf(r),
        trust: { score: r.trust, kept: r.kept, broken: r.broken, void: r.void },
        games: r.games,
      })),
      offset,
      limit,
      next: rows.length > limit ? offset + limit : null,
    };
  }

  // ---------- PlayerStore: rating history ----------

  async ratingHistory(handle: string, now: number, limit?: number): Promise<RatingHistoryResponse | null> {
    const row = await this.playerByHandle(handle, now);
    if (!row) return null;
    const n = clampLimit(limit, HISTORY_POINTS.max, HISTORY_POINTS.fallback);
    const rows = (
      await this.db
        .prepare(
          `SELECT h.game_id, h.rating_before, h.rd_before, h.rating_after, h.rd_after, h.at, gp.power, gp.result, gp.score
           FROM rating_history h
           LEFT JOIN game_players gp ON gp.game_id = h.game_id AND gp.player_id = h.player_id
           WHERE h.player_id = ? AND h.ladder = ?
           GROUP BY h.game_id
           ORDER BY h.at DESC, h.game_id DESC LIMIT ?`,
        )
        .bind(row.id, LADDER, n + 1)
        .all<HistoryRow>()
    ).results;
    return {
      ladder: LADDER,
      points: rows
        .slice(0, n)
        .reverse()
        .map((h) => ({
          gameId: h.game_id,
          power: (h.power as RatingHistoryResponse["points"][number]["power"]) ?? null,
          result: (h.result as RatingHistoryResponse["points"][number]["result"]) ?? null,
          score: h.score,
          ratingBefore: h.rating_before,
          rdBefore: h.rd_before,
          ratingAfter: h.rating_after,
          rdAfter: h.rd_after,
          at: h.at,
        })),
      more: rows.length > n,
    };
  }

  // ---------- PlayerStore: leaving for good ----------

  async gamesOf(playerId: string): Promise<string[]> {
    const rows = (await this.db.prepare("SELECT DISTINCT game_id FROM game_players WHERE player_id = ? ORDER BY game_id").bind(playerId).all<{ game_id: string }>()).results;
    return rows.map((r) => r.game_id);
  }

  async deletePlayer(playerId: string, unplayed: readonly string[] = []): Promise<void> {
    // The seats they held at the end of each recorded game, whose name the game's record still shows.
    const held = (
      await this.db
        .prepare(
          `SELECT gp.game_id, gp.power, g.seats_json FROM game_players gp JOIN games_index g ON g.game_id = gp.game_id
           WHERE gp.player_id = ? AND gp.left_reason IS NULL`,
        )
        .bind(playerId)
        .all<{ game_id: string; power: string; seats_json: string }>()
    ).results;
    const games = new Map<string, { seats: GameRecord["seats"]; powers: Set<string> }>();
    for (const h of held) {
      const entry = games.get(h.game_id) ?? { seats: JSON.parse(h.seats_json) as GameRecord["seats"], powers: new Set<string>() };
      entry.powers.add(h.power);
      games.set(h.game_id, entry);
    }
    const quoted = JSON.stringify(playerId);
    await this.db.batch([
      // A listing still naming them as host (a room that could not be told) names a ghost instead.
      this.db
        .prepare(
          `UPDATE games_live SET host_name = ? WHERE host_name = (SELECT handle FROM players WHERE id = ?)
           AND game_id IN (SELECT game_id FROM game_players WHERE player_id = ?)`,
        )
        .bind(GHOST, playerId, playerId),
      // A lobby seat that opened again was never played: no anonymous holder stays behind for it.
      ...unplayed.map((gameId) => this.db.prepare("DELETE FROM game_players WHERE game_id = ? AND player_id = ?").bind(gameId, playerId)),
      ...[...games].map(([gameId, g]) =>
        this.db
          .prepare("UPDATE games_index SET seats_json = ? WHERE game_id = ?")
          .bind(JSON.stringify(g.seats.map((s) => (g.powers.has(s.power) && s.kind !== "ai" ? { ...s, name: GHOST } : s))), gameId),
      ),
      // The stints stay, so every game still has a holder for every seat, but nobody's name or id.
      this.db.prepare("UPDATE game_players SET player_id = NULL, name = ? WHERE player_id = ?").bind(GHOST, playerId),
      // Other players' ratings moved against this player; the breakdown keeps the move, not the id.
      this.db.prepare("UPDATE rating_history SET opponents_json = REPLACE(opponents_json, ?, 'null') WHERE instr(opponents_json, ?) > 0").bind(quoted, quoted),
      this.db.prepare("DELETE FROM rating_history WHERE player_id = ?").bind(playerId),
      this.db.prepare("DELETE FROM ratings WHERE player_id = ?").bind(playerId),
      this.db.prepare("DELETE FROM player_stats WHERE player_id = ?").bind(playerId),
      this.db.prepare("DELETE FROM push_subscriptions WHERE player_id = ?").bind(playerId),
      this.db.prepare("DELETE FROM notification_preferences WHERE player_id = ?").bind(playerId),
      this.db.prepare("DELETE FROM handle_aliases WHERE player_id = ?").bind(playerId),
      this.db.prepare("DELETE FROM player_sessions WHERE player_id = ?").bind(playerId),
      ...forgetInModeration(this.db, playerId),
      this.db.prepare("DELETE FROM players WHERE id = ?").bind(playerId),
    ]);
  }
}

export interface HistoryRow {
  game_id: string;
  rating_before: number;
  rd_before: number;
  rating_after: number;
  rd_after: number;
  at: number;
  power: string | null;
  result: string | null;
  score: number | null;
}

interface RecentRow {
  game_id: string;
  power: string;
  result: string;
  score: number | null;
  centers: number | null;
  substitute: number;
  left_reason: string | null;
  civil_disorder: number;
  finished_at: number;
  public: number | null;
  delta: number | null;
}

function toResult(g: RecentRow, own: boolean): PlayerResult {
  return {
    gameId: own || g.public === 1 ? g.game_id : null,
    power: g.power as PlayerResult["power"],
    result: g.result as PlayerResult["result"],
    score: g.score ?? 0,
    centers: g.centers ?? 0,
    substitute: g.substitute === 1,
    walkedOut: g.left_reason !== null || g.civil_disorder === 1,
    ratingDelta: g.delta,
    finishedAt: g.finished_at,
  };
}

function gameRow(record: GameRecord): unknown[] {
  return [
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
    record.settings.visibility === "public" ? 1 : 0,
  ];
}

const taken = (): RenameOutcome => ({ ok: false, status: 409, code: "handle_taken", message: "that handle is taken" });

function handleRefusal(handle: string): RenameOutcome | null {
  const problem = handleProblem(handle);
  if (problem === null) return null;
  return { ok: false, status: 400, code: `handle_${problem}`, message: HANDLE_PROBLEMS[problem] };
}

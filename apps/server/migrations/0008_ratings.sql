-- Ratings (weighted pairwise Glicko-2, see docs/adr/0011), their history per game, and per-player
-- totals for reliability and the trust ledger. D1 only. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS ratings (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  ladder TEXT NOT NULL,
  rating REAL NOT NULL,
  rd REAL NOT NULL,
  volatility REAL NOT NULL,
  games INTEGER NOT NULL,
  -- rating - 2 * rd: what the leaderboard orders by.
  conservative REAL NOT NULL,
  last_game_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, ladder)
);
CREATE INDEX IF NOT EXISTS ratings_board ON ratings(ladder, conservative DESC);
CREATE TABLE IF NOT EXISTS rating_history (
  player_id TEXT NOT NULL,
  ladder TEXT NOT NULL,
  game_id TEXT NOT NULL,
  rating_before REAL NOT NULL,
  rd_before REAL NOT NULL,
  rating_after REAL NOT NULL,
  rd_after REAL NOT NULL,
  -- Per-opponent breakdown: [{ playerId, score, expected, delta }].
  opponents_json TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (player_id, ladder, game_id)
);
CREATE INDEX IF NOT EXISTS rating_history_player ON rating_history(player_id, at DESC);
-- A game is rated at most once: inserting its row is the first statement of the rating batch.
CREATE TABLE IF NOT EXISTS rated_games (
  game_id TEXT PRIMARY KEY,
  ladder TEXT NOT NULL,
  players INTEGER NOT NULL,
  rated_at INTEGER NOT NULL
);
-- Compare-and-swap for a batch: inserting NULL here fails the batch, rolling it back.
CREATE TABLE IF NOT EXISTS batch_guard (ok INTEGER NOT NULL);
-- Totals per player, recomputed from game_players in one statement whenever one of their games ends.
CREATE TABLE IF NOT EXISTS player_stats (
  player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  games INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  walked_out INTEGER NOT NULL,
  solos INTEGER NOT NULL,
  draws INTEGER NOT NULL,
  phases_due INTEGER NOT NULL,
  phases_on_time INTEGER NOT NULL,
  phases_late INTEGER NOT NULL,
  kept INTEGER NOT NULL,
  broken INTEGER NOT NULL,
  void INTEGER NOT NULL,
  reliability REAL NOT NULL,
  trust REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS player_stats_trust ON player_stats(trust DESC);

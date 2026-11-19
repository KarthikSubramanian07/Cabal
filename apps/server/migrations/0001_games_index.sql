-- The cross-game index of finished and abandoned games (from PR #68, by Justin Obomeghie).
-- Valid for SQLite in a Durable Object and for D1. Never edit a migration that has shipped.
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

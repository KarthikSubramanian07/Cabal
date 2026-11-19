-- The deployment-wide Claude budget. A game that wants Claude seats is admitted here before it
-- starts, for the whole of its per-game spend cap, on the UTC day it asks. When it ends it hands
-- back what it did not spend. A day's commitments are the caps of the games admitted that day that
-- are still running plus what the ended ones spent, so the sum can never pass the daily budget.
-- Valid for SQLite in a Durable Object and for D1. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS claude_games (
  game_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  cap_micros INTEGER NOT NULL,
  admitted_at INTEGER NOT NULL,
  released_at INTEGER,
  spent_micros INTEGER
);
CREATE INDEX IF NOT EXISTS claude_games_day ON claude_games(day);
CREATE INDEX IF NOT EXISTS claude_games_open ON claude_games(released_at, admitted_at);

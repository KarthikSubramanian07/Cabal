-- What follows a signed-in player between devices: their settings and their sandbox game, each
-- with the time it was written so the latest write wins. One row per player, made on first save.
-- Deleting the account deletes the row. D1 only. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS player_sync (
  player_id TEXT PRIMARY KEY,
  prefs_json TEXT,
  prefs_at INTEGER,
  sandbox TEXT,
  sandbox_at INTEGER
);

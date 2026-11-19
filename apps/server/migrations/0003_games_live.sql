-- Public games that are open (in the lobby) or running. A room upserts its row as it changes and
-- the row is deleted when the game is recorded in games_index. Unlisted games never appear here.
CREATE TABLE IF NOT EXISTS games_live (
  game_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('lobby', 'active', 'paused')),
  settings_json TEXT NOT NULL,
  cluster TEXT NOT NULL,
  host_name TEXT,
  humans INTEGER NOT NULL,
  open_seats INTEGER NOT NULL,
  phase TEXT NOT NULL,
  deadline_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS games_live_status ON games_live(status, created_at DESC);

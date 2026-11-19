-- One row per stint at a seat: who held which power in which game, from when, how reliably, and
-- how it ended for them. A seat that changed hands (a substitute took it over) has several stints.
-- Rooms write a row when a signed-in player takes a seat; the finished game's record completes
-- every row. Anonymous and AI seats have no player_id. D1 only. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL,
  power TEXT NOT NULL,
  stint INTEGER NOT NULL,
  player_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'ai')),
  name TEXT,
  joined_at INTEGER NOT NULL,
  substitute INTEGER NOT NULL DEFAULT 0,
  -- 'playing' until the game ends; then 'finished', 'abandoned', or 'void' (ended before a phase).
  status TEXT NOT NULL CHECK (status IN ('playing', 'finished', 'abandoned', 'void')),
  -- Null while the stint lasts or when it lasted to the end; 'replaced' when a substitute took over.
  left_reason TEXT,
  -- The game's result, and this power's share of it (0 for a stint that did not last to the end).
  result TEXT,
  score REAL,
  centers INTEGER,
  eliminated INTEGER NOT NULL DEFAULT 0,
  -- The seat was in civil disorder when the game ended: its player had walked away.
  civil_disorder INTEGER NOT NULL DEFAULT 0,
  -- Phases this stint had something to order, ordered before the deadline, and ordered in the grace period.
  phases_due INTEGER NOT NULL DEFAULT 0,
  phases_on_time INTEGER NOT NULL DEFAULT 0,
  phases_late INTEGER NOT NULL DEFAULT 0,
  -- Receipts of this stint's pledges that count towards the trust ledger.
  kept INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0,
  void INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  PRIMARY KEY (game_id, power, stint)
);
CREATE INDEX IF NOT EXISTS game_players_player ON game_players(player_id, joined_at DESC);

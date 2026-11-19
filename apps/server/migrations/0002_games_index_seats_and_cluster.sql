ALTER TABLE games_index ADD COLUMN reason TEXT;
ALTER TABLE games_index ADD COLUMN cluster TEXT NOT NULL DEFAULT 'standard:full:async';
ALTER TABLE games_index ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games_index ADD COLUMN seats_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS games_index_cluster ON games_index(cluster, finished_at DESC);

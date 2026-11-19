-- Small facts about the index itself, such as when rows were copied across from the Registry.
-- D1 only. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

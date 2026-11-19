-- Guest-first players. A player is a random id and a handle; a device proves it is the player with a
-- bearer secret, of which only a SHA-256 is stored (one row per device). A recovery code, also stored
-- only as a hash, restores the player on a new device. No email, no password, no passkey.
-- D1 only (the Registry stops at 0005). Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  -- The handle folded to how it reads (handles.ts `handleKey`: lower case, `_` as `-`, look-alikes
  -- such as `1`, `i` and `l` as one): handles are unique by how they read, not only whatever their case.
  handle_key TEXT NOT NULL UNIQUE,
  recovery_hash TEXT UNIQUE,
  recovery_issued_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  handle_changed_at INTEGER
);
CREATE TABLE IF NOT EXISTS player_sessions (
  secret_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS player_sessions_player ON player_sessions(player_id, created_at);
-- A handle a player gave up stays theirs for a while: links to the old profile keep working and
-- nobody else can take the name straight away.
CREATE TABLE IF NOT EXISTS handle_aliases (
  handle_key TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  until INTEGER NOT NULL
);

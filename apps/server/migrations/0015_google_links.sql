-- Sign in with Google: which Cabal account a Google account opens. Only a hash of Google's stable
-- account id (`sub`) is kept, never an email address or a name (google.ts `googleSubjectKey`).
-- One Google account opens one Cabal account, and a Cabal account links at most one Google
-- account. Deleting the account deletes its link (d1-index.ts `deletePlayer`).
-- D1 only. Additive. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS google_links (
  subject_key TEXT PRIMARY KEY,
  player_id TEXT NOT NULL UNIQUE,
  linked_at INTEGER NOT NULL
);

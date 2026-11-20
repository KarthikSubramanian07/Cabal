-- Moderation (issue #12): players' reports about other players, for a maintainer to review, and a
-- daily count of the accounts made from one network address, which flags a burst of accounts for
-- review. The address is never stored: only an HMAC of the day and the address under a Worker secret, kept two days.
-- D1 only. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS player_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Null once the reporter deletes their account; the report stays for review.
  reporter_id TEXT,
  subject_id TEXT NOT NULL,
  -- cheating | abuse | multi_account | other
  reason TEXT NOT NULL,
  note TEXT,
  game_id TEXT,
  -- Start of the UTC day, in ms: one report per reporter, subject and day counts.
  day INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS player_reports_once_a_day ON player_reports (reporter_id, subject_id, day);
CREATE INDEX IF NOT EXISTS player_reports_newest ON player_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS player_reports_subject ON player_reports (subject_id);

CREATE TABLE IF NOT EXISTS account_origins (
  -- hex SHA-256 of "<day>:<address>", so a key cannot be followed from one day to the next.
  origin_key TEXT NOT NULL,
  day INTEGER NOT NULL,
  accounts INTEGER NOT NULL,
  PRIMARY KEY (origin_key, day)
);

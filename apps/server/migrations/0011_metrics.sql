-- Phase 1 success metrics (docs/PLAN.md section 8, issue #57), as events. No personal data: no
-- player, no address, no device. Browser timings carry only the continent Cloudflare saw the
-- request from; a finished game is recorded once, keyed by its code, from the game's own record.
-- D1 only. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS metric_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- datc | full_game | landing_to_game | order_rtt
  metric TEXT NOT NULL,
  at INTEGER NOT NULL,
  -- Milliseconds for timings, passed cases for DATC, phases played for a game.
  value REAL NOT NULL,
  -- 1 when this one event meets its target on its own (a game that finished, a clean DATC run).
  ok INTEGER,
  -- Two-letter continent code for browser timings (EU, NA, ...), else null.
  region TEXT,
  detail_json TEXT,
  -- Makes recording idempotent where an event can be reported twice (a game's record is retried).
  dedupe TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS metric_events_by_metric ON metric_events(metric, at);

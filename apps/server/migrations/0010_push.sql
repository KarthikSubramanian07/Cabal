-- Web Push. One row per browser a signed-in player has subscribed, tied to the device session that
-- subscribed it: signing that device out (or the session making way past the cap) forgets it. The
-- endpoint is the push service's address for that browser; p256dh and auth are the keys messages
-- are encrypted to (RFC 8291). Nothing here says who the player is beyond their id.
-- D1 only. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES player_sessions(secret_hash) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Deliveries that failed in a row for a reason other than the subscription being gone.
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_player ON push_subscriptions(player_id, created_at);
CREATE INDEX IF NOT EXISTS push_subscriptions_session ON push_subscriptions(session_hash);
-- Which notifications a player wants. No row means every kind is on.
CREATE TABLE IF NOT EXISTS notification_preferences (
  player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  deadline INTEGER NOT NULL DEFAULT 1,
  phase INTEGER NOT NULL DEFAULT 1,
  press INTEGER NOT NULL DEFAULT 1,
  started INTEGER NOT NULL DEFAULT 1,
  finished INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

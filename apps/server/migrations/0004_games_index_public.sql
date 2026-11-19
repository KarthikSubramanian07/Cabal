-- Whether a recorded game may appear in the public list of finished games. Every game is recorded
-- (ratings and the trust ledger need them all), but only games created as public are listed: an
-- unlisted game's code, settings and player names stay with the people who were given the code.
-- Valid for SQLite in a Durable Object and for D1. Never edit a migration that has shipped.
ALTER TABLE games_index ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
UPDATE games_index SET public = 1 WHERE json_extract(settings_json, '$.visibility') = 'public';
CREATE INDEX IF NOT EXISTS games_index_public ON games_index(public, finished_at DESC);

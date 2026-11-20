-- A deleted account's handles (the one it went by, and any it gave up and still held) are held for a
-- while before anyone else may take them. A room that could not be told about the deletion still
-- names the old handle until it next asks the index which of its accounts exist (room.ts
-- `checkAccounts`); the hold outlasts that, so the name never links to a newcomer in the meantime.
-- Only the folded handle and an expiry are kept: nothing ties a hold to the account it came from.
-- D1 only. Additive. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS handle_holds (
  handle_key TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);

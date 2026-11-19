# ADR 0010: The cross-game index moves to D1; the Registry keeps the Claude budget

Status: accepted (2026-11-19). Supersedes [ADR 0009](0009-registry-durable-object-instead-of-d1.md).

## Context

ADR 0009 put everything that spans games in a singleton `Registry` Durable Object because the Cloudflare account was at its D1 limit. A D1 slot has since been freed and the database `cabal` exists. The index was always reached through one narrow port, `GameIndex`, with plain SQL in numbered migration files written to be valid for both SQLite-in-a-Durable-Object and D1, so that this move would be a new adapter and a binding.

Two things changed what the index has to do. Players, ratings, reliability and the trust ledger are being built now, and they are read far more than they are written: profile pages, a leaderboard, a global ledger, a player's own games. And the owner wants a SQL console and point-in-time recovery (D1 Time Travel) for that data.

## Decision

- The index lives in D1 (`cabal`, binding `DB`). `apps/server/src/d1-index.ts` implements `GameIndex` and a second port, `PlayerStore`, for accounts and standing. The schema is `apps/server/migrations/0001` onwards, applied with `wrangler d1 migrations apply cabal`; the workerd test suite applies the same files to a local D1 database before it runs.
- Correctness does not rely on a single writer. Every multi-row change is one `batch` (one transaction). Recording a finished game is idempotent. A game is rated at most once because the rating batch starts by inserting its `rated_games` row. Two games ending at once for the same player cannot lose an update: the batch re-checks each player's rating count (an insert into `batch_guard` that fails the batch when the count moved) and is retried. Per-player totals are recomputed from rows in one statement, never incremented.
- The `Registry` stays deployed (Durable Object classes are never deleted) and keeps the deployment-wide Claude budget. Admission is check-then-write against a daily sum and a count of games in play; inside one object it is one synchronous step by construction. D1 could do the same with a single conditional insert, but nothing would be gained and the budget is the one place where an error spends money. The D1 adapter hands `admitClaudeGame` and `releaseClaudeGame` to the Registry. The Registry's schema stops at migration 5.
- The Registry's games index and live listings are copied into D1 once: in the background of the first request an isolate serves, idempotently (rows already in D1 are kept, being newer), and marked done in `index_meta` only when the copy finished.
- Where no D1 database is bound, the Registry serves the games index as before, and the player routes answer 503.

## Consequences

- `/health` reports the index (`index: { backend, reachable, schema }`) and the Registry separately.
- Remote migrations are a deploy step the maintainer runs before `wrangler deploy` (`wrangler d1 migrations apply cabal --remote`); a Worker running ahead of its schema would fail its queries, so the order matters.
- Reads scale with D1, and the data can be inspected and restored with D1's own tools.
- The Claude budget and the index can no longer be read in one transaction. Nothing needs to: a game's admission and its record are separate events.

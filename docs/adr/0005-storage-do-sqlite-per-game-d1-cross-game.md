# ADR 0005: Durable Object SQLite per game, D1 for cross-game data

Status: accepted (2026-09-15). The per-game half stands. The D1 half was set aside by [ADR 0009](0009-registry-durable-object-instead-of-d1.md) while the account was at its D1 database limit, and restored by [ADR 0010](0010-d1-index-registry-for-the-claude-budget.md): the cross-game index is in the D1 database `cabal`, behind the `GameIndex` and `PlayerStore` ports, and the `Registry` Durable Object keeps only the Claude budget.

## Decision

Each game's phases, orders, messages, pledges and votes live in the `GameRoom` Durable Object's SQLite storage. Accounts, ratings, trust ledgers and the games index live in D1. On game end the object writes a summary row to D1 through the API worker.

## Consequences

- Adjudicate, persist and broadcast happen in one object with no network hop.
- Cross-game queries (leaderboards, profiles) never touch game objects.
- Replays are a read of the object's `phases` table or the exported saved game JSON.

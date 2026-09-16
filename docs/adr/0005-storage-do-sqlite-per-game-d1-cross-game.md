# ADR 0005: Durable Object SQLite per game, D1 for cross-game data

Status: accepted (2026-09-15)

## Decision

Each game's phases, orders, messages, pledges and votes live in the `GameRoom` Durable Object's SQLite storage. Accounts, ratings, trust ledgers and the games index live in D1. On game end the object writes a summary row to D1 through the API worker.

## Consequences

- Adjudicate, persist and broadcast happen in one object with no network hop.
- Cross-game queries (leaderboards, profiles) never touch game objects.
- Replays are a read of the object's `phases` table or the exported saved game JSON.

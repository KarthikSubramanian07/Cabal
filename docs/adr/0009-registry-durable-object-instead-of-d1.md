# ADR 0009: A Registry Durable Object for cross-game data, instead of D1

Status: superseded by [ADR 0010](0010-d1-index-registry-for-the-claude-budget.md) (2026-11-19). Supersedes the D1 half of [ADR 0005](0005-storage-do-sqlite-per-game-d1-cross-game.md).

## Context

ADR 0005 put each game in its own `GameRoom` Durable Object and put everything that spans games (accounts, ratings, trust ledgers, the games index) in a D1 database. No D1 database was ever created for Cabal, and the Cloudflare account it deploys to is at its D1 database limit, so a new one cannot be created without deleting a database that another project uses.

The cross-game data is small and has one writer pattern: a game finishes, and one summary is folded into the index, the ratings and the trust ledger. Reads are profile pages and a leaderboard. None of it needs D1's read replication or its HTTP query API.

## Decision

Cross-game data lives in one singleton Durable Object class, `Registry`, with SQLite storage.

- The Worker binds it as `env.REGISTRY` and always addresses it with `idFromName("global")`, so there is exactly one instance.
- Callers use typed RPC methods on the object (for example recording a finished game, reading a profile, reading the leaderboard). Nothing outside the class issues SQL against it.
- It holds the finished-games index, players, ratings (weighted pairwise Glicko, see issue #12), reliability, the trust ledger (pledges kept, broken and void per player), and push subscriptions.
- Its SQL schema is created and changed by versioned migrations that run inside the object when it starts, and that only add tables and columns, so older code can still open newer storage (see the rollback notes in [ADR 0008](0008-manual-wrangler-deploys.md)).
- Adding the class needs a new migration tag in `apps/server/wrangler.jsonc` (`new_sqlite_classes: ["Registry"]`), deployed on its own.

The per-game half of ADR 0005 is unchanged: a game's phases, orders, press, pledges and votes stay in its `GameRoom`.

## Consequences

- No new Cloudflare resource to create, bind or pay for, and no account limit to negotiate.
- Writes are serialised through one object. At Cabal's scale (a write per finished game, a few reads per page view) that is a feature: rating updates cannot race. If it ever becomes a bottleneck, reads can be served from a cached snapshot, or the registry can be split by key (for example one object per player for profiles) without changing callers, because callers only see RPC methods.
- One object lives in one location, so a reader far from it pays the round trip. Profile and leaderboard reads are not on the order submission path, so the phase 1 latency target is unaffected.
- There is no SQL console in the dashboard as there is for D1. Inspecting data means a maintainer RPC method or an export route, which should be added with the class.
- Backups rely on Durable Object point-in-time recovery for SQLite storage rather than D1 Time Travel.

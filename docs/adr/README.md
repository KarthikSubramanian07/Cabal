# Architecture decision records

| # | Decision |
|---|---|
| [0001](0001-rust-engine-single-wasm-artifact.md) | One Rust engine, compiled once to WebAssembly, used in browser and server |
| [0002](0002-typescript-durable-object-over-workers-rs.md) | TypeScript Durable Object hosting the WASM engine instead of workers-rs |
| [0003](0003-kruijswijk-partial-information-resolver.md) | Kruijswijk partial information algorithm for movement resolution |
| [0004](0004-cabal-layer-above-adjudication.md) | Cabal mechanics are layers over adjudication results, never rule changes |
| [0005](0005-storage-do-sqlite-per-game-d1-cross-game.md) | Durable Object SQLite per game, D1 for cross-game data |
| [0006](0006-mila-order-notation.md) | MILA / Cicero order notation and saved game format |
| [0007](0007-pledges-commit-reveal.md) | Pledges as BLAKE3 commit-reveal verified by the server |

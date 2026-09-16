# ADR 0001: One Rust engine, one WASM artifact, two hosts

Status: accepted (2026-09-15)

## Context

Diplomacy adjudication is subtle (164 DATC test cases, convoy paradoxes, coasts, civil disorder) and must be identical on the client (for instant legality feedback and previews) and the server (authority). Writing it twice guarantees drift.

## Decision

Implement the engine once in Rust (`crates/cabal-engine`), pure and deterministic, with no I/O. Compile it with `wasm-pack --target web` into a single `.wasm` plus generated bindings (`packages/engine`). The browser and the Cloudflare Durable Object both load that artifact.

## Consequences

- Client and server cannot disagree on rules.
- Rust gives us proptest, cargo-fuzz, criterion and insta for a rules engine that deserves them.
- WASM size is a budget: CI fails the build above 400 KB gzip.
- The engine crate must not depend on `web-sys`, threads or `getrandom` so it compiles for native tests and wasm identically.

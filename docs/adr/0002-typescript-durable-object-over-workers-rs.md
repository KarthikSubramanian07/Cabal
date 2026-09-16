# ADR 0002: TypeScript Durable Object hosting the WASM engine

Status: accepted (2026-09-15)

## Context

Cloudflare offers `workers-rs` (Rust Workers with Durable Object support, 0.8.x) and native TypeScript Durable Objects. The engine already ships as wasm-bindgen output for the browser.

## Decision

The `GameRoom` Durable Object is TypeScript (built on `partyserver`) and imports the same `cabal_engine_bg.wasm` through Wrangler's `CompiledWasm` rule. All rules logic still runs in Rust; TypeScript owns only I/O and orchestration (sockets, SQLite, alarms, auth).

## Consequences

- One WASM toolchain instead of two (worker-build plus wasm-pack).
- First-class access to the Hibernation API, `ctx.storage.sql`, RPC, vitest-pool-workers and the Agents SDK, all of which land in TypeScript first.
- If the team later prefers an all-Rust server, the engine boundary makes that a swap of the host, not the rules.

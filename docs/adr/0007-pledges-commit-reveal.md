# ADR 0007: Pledges as commit-reveal, verified by the server

Status: accepted (2026-09-15)

## Context

No Diplomacy platform offers press with proof. Cryptographic commitment is cheap, and the server already sees both the pledge and the actual orders.

## Decision

A pledge is a set of canonical order strings plus a 128-bit nonce. `commitment = blake3(canonical_orders || nonce)`. Open pledges reveal orders to the audience immediately; sealed pledges reveal after adjudication. The server verifies by comparing pledged orders to the pledger's submitted orders for that phase and broadcasts `kept`, `broken` or `void`. The hashing lives in the engine crate so clients and auditors can recompute it from a saved game.

## Consequences

- Trust ledgers are auditable from replays.
- No blockchain, no keys to manage; the server is the trusted verifier, which is appropriate because it is also the adjudicator.

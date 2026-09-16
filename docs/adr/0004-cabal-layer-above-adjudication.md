# ADR 0004: Cabal mechanics are layers above adjudication

Status: accepted (2026-09-15)

## Context

Pledges, trust scores, secret cabals, vendettas, ghost votes and scoring variants are the product's identity. None of them need to change how orders resolve, and every surveyed mechanic (Solium Infernum vendettas, Avalon style hidden roles, Payola bids, Welfare Diplomacy scoring) can be expressed as a function of the public adjudication result.

## Decision

The engine exposes adjudication results and legal orders. Everything cabal-flavoured consumes those results in the server or client and never feeds back into resolution. The one engine-level helper (`pledge` module) is pure hashing and comparison.

## Consequences

- DATC compliance is never at risk from product features.
- Variants that do change rules (Fog of War is a visibility filter, Build Anywhere is a rulebook flag) are the only things that touch the engine, and they enter through `Rulebook` data.

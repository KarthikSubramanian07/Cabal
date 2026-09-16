# ADR 0003: Kruijswijk partial information resolver

Status: accepted (2026-09-15)

## Context

Three families of adjudicators exist: DPjudge-style iterative heuristics (MILA engine), Kruijswijk guess-and-backtrack (godip, the MIT `diplomacy` crate) and Kruijswijk partial information (jDip, webDiplomacy). DATC v3.0 chapter 5 recommends partial information for robustness because every order that can be decided on partial information is decided that way before any backup rule is applied.

## Decision

Implement the partial information algorithm with the `recursion_hits` and `uncertain` refinements from DATC 5.E. Backup rules: circular movement (all moves succeed) and Szykman (convoys in the cycle fail). Illegal orders are stripped before resolution. Editions are data (`Rulebook`).

## Consequences

- Every order is adjudicated at most twice (optimistic and pessimistic); the `uncertain` optimisation skips the second pass when nothing was undecided.
- Explanations are produced by a final pass over resolved Booleans, giving the UI a reason per order and a dependency graph.
- The corpus from the MIT `diplomacy` crate (DATC v3.0, 171 cases) is vendored with attribution as the primary test oracle.

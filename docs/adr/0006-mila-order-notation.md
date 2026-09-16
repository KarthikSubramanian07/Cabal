# ADR 0006: MILA / Cicero order notation and saved game format

Status: accepted (2026-09-15)

## Decision

Order text uses the notation of the MILA `diplomacy` engine and Cicero (`A PAR - BUR`, `F NTH C A LON - BRE`, `A LON - BRE VIA`, `F STP/NC`). Saved games serialise to the MILA saved game format (`phases[].{name,state,orders,results,messages}`), with Cabal extensions under a namespaced key.

## Consequences

- Every existing AI harness (Cicero, AI Diplomacy, Welfare Diplomacy, DipLLM) and visualiser understands our games without conversion.
- The parser must be lenient (case, `->`, `SUPPORTS`) but the canonical form is the MILA one.

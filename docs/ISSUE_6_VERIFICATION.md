# Issue #6 verification

## Independent position oracle

`crates/cabal-engine/tests/oracle.rs` runs every entry of
`tests/data/oracle_godip.json`, with no ignored cases. It compares complete unit
vectors, complete dislodged-unit vectors (including attacker origins and convoy
flags for movement), and the entire supply-center ownership map. It does not
obtain expected results from Cabal. The original 171 DATC cases are unchanged.

The oracle has 20 cases:

- All 9 DipAI phases from `dipai.txt`: four movement, three retreat, two adjustment.
- All 4 Describe game positions from `real.txt`.
- All 4 production errors from `droidippy_errors.txt`.
- The production error from `diplicity_errors.txt`.
- Official DATC v3.0 6.B.15 and 6.C.8, with full positions rather than only order outcomes. These also appear in the original DATC corpus; the oracle adds full-state assertions, not new DATC identifiers.

The independent checkout was read directly from `GODIP_REF`, at godip commit
`cd244421928227a806808b51848ad290f88017fc`. Each production entry records the
upstream path, original case identifier, immutable GitHub source URL, file SHA256,
and rule references. Original order text and unit spellings are retained; the
runner translates only notation (`nrg` → `nwg`, `mid` → `mao`, `gol` → `lyo`, and
unspaced move hyphens). It does not infer starting units from orders.

Run `python3 tools/check_godip_oracle.py` with `GODIP_REF` set to independently
check all 18 transcriptions against that checkout. This tool is read-only and
checks starting units, dislodged units, preceding results, phase, orders, expected
units, source dislodgements, and ownership. It never calls the Cabal resolver.

### Phase boundary differences

Godip's `phase/phase.go:361-375` immediately removes dislodged units that have no
legal retreat. Cabal's movement resolver retains them until retreat resolution.
The corpus records both `expected_dislodged` at Cabal's movement boundary and
`upstream_poststate_dislodged` exactly as documented upstream. The runner asserts
both complete states, verifying that each additional pending unit has only the
disband option; it never drops an unexpected unit that could legally retreat.
The three forced destructions are:

| Source case | Unit | Independent reason it cannot retreat |
| --- | --- | --- |
| DipAI:F01M | France A pie | Tuscany is the attacker's origin; Marseilles, Venice, Tyrolia are occupied. |
| Describe Spring 1910 | France A mar | Gascony, Burgundy, Piedmont, Spain are occupied. |
| Failed convoy tun to gre | Turkey A gre | Serbia is the attacker's origin; Albania, Bulgaria, Ionian Sea are occupied. |

The DipAI retreat fixture spells the already doomed Piedmont unit `F pie`,
although its movement fixture has `A pie`. The source spelling is retained in
the retreat starting state; its explicit disband has the same documented result.

Owners unspecified by the upstream fixture are an explicitly empty map, matching
godip's blank test state. The low-level phase resolvers preserve that map;
adjustment cases transcribe the full explicit upstream owner map. This corpus
checks resolver phase boundaries, not `Game.process`'s subsequent phase skipping
or Fall ownership update. Retreat restrictions present in `PRESTATE_RESULTS`
are transcribed and restored without running Cabal's preceding movement resolver.

### Unresolved source requirement

Issue #6 requests **DATC 6.K.1 and 6.K.2**. The published
[DATC v3.0 specification](https://webdiplomacy.net/doc/DATC_v3_0.html) ends at
6.J.11; its table of contents contains only sections A–J. Godip's checked-in
`datc_v2.4_06.txt` also ends at 6.J.11. No official source for 6.K.1 or 6.K.2
was located. These identifiers have not been invented, relabelled, skipped, or
claimed as passing. The two supplemental official cases above are **not**
substitutes for this unresolved requirement. The issue cannot truthfully be
reported fully complete without a source or a correction to these identifiers.

## Normalisation and explanations

`order::normalise(map, position, order)` uses the actual board unit, canonicalises
army destination coasts and inferred fleet coasts, and removes irrelevant
support destination coasts. Real but unreachable fleet coasts still fail.
DATC 4.B.5, 4.B.6, 4.C.1 and 4.C.2 have explicit-position tests; property tests
check normalisation idempotence. Resolver validation consumes the canonical order.

The additive WASM `Game.normaliseOrders` method is called by server adjudication
and browser sandbox adjudication/replay before `Game.process`. It retains illegal
and duplicate orders so resolver diagnostics remain available. Direct WASM
processing also normalises typed movement orders. Explicit power prefixes are
preserved. Existing exports and Rust parse/legal/resolver signatures remain.

`resolve_movement_with_dependencies` traces actual resolver queries, including
cached queries and cycles. Sorted nodes and edges produce deterministic Graphviz
DOT through `MovementDependencies::to_dot`. CLI `cabal explain --graph` emits a
standalone graph. WASM `PhaseOutcome.dependencies` indexes `results`, and
`dependency_dot` supplies the labelled graph (empty edges and null DOT for other
phases). Rust corpus tests check traced/untraced equivalence and permutation
invariance; TypeScript tests exercise normalisation, diagnostics, edges, DOT and
JSON transport through the real compiled WASM module.

## Fuzzing and checks

The parser target calls `parse::parse` on arbitrary byte input decoded as lossy
UTF-8, checks serialization and attempts all three phase conversions. The
movement target generates valid sparse or initial positions and selects a legal
order for every unit, then calls `resolve_movement` and checks idempotence,
permutation invariance, conservation, ownership, and unique occupation.
`fuzz/Cargo.toml` isolates nightly fuzz dependencies from the stable workspace.
The scheduled stress workflow has separate parser/movement matrix jobs, each
with `-max_total_time=600`, `fail-fast: false`, and crash artifact upload.

Local commands and final results are recorded below once their runs finish.

## Files in the resulting Issue #6 working tree

The work started with uncommitted CLI, tracing, normalisation tests, DATC test
improvements, fuzzing, workflow and architecture changes. Those were preserved
and verified. The nested untracked `Cabal/` directory was not modified.

- Engine implementation: `crates/cabal-engine/src/order.rs`,
  `crates/cabal-engine/src/geo.rs`, `crates/cabal-engine/src/adjudicate/movement.rs`.
- Engine tests/data: `crates/cabal-engine/tests/datc.rs`,
  `crates/cabal-engine/tests/properties.rs`, `crates/cabal-engine/tests/normalisation.rs`,
  `crates/cabal-engine/tests/dependencies.rs`, `crates/cabal-engine/tests/oracle.rs`,
  `crates/cabal-engine/tests/data/oracle_godip.json`.
- CLI: `crates/cabal-cli/src/main.rs`, `crates/cabal-cli/tests/explain.rs`.
- Shared WASM and hosts: `crates/cabal-wasm/src/lib.rs`,
  `packages/engine/src/engine.test.ts`, `apps/server/src/room.ts`,
  `apps/web/src/game/useSandbox.ts`.
- Fuzz infrastructure: `fuzz/Cargo.toml`, `fuzz/Cargo.lock`,
  `fuzz/fuzz_targets/parser.rs`, `fuzz/fuzz_targets/movement.rs`, `fuzz/README.md`,
  named seeds `fuzz/corpus/parser/coast`, `fuzz/corpus/parser/convoy`,
  `fuzz/corpus/movement/opening`, `.github/workflows/stress.yml`, `.gitignore`.
- Provenance and documentation: `tools/check_godip_oracle.py`,
  `docs/ARCHITECTURE.md`, this report.

Generated SHA-1-named fuzz discoveries, crash artifacts, logs, and WASM package
output remain local/ignored. No unrelated files were deleted. No commit, push,
pull request, issue update, or deployment was performed.

## Verified functional results

| Check | Result |
| --- | --- |
| `python3 tools/check_godip_oracle.py` | All 18 original production transcriptions match the independent checkout. |
| `cargo fmt --all` and format check | Pass. |
| `cargo test --workspace` | 41 passed, 0 failed; one pre-existing ignored fixture-writing helper (`make_fixture`), which is not a corpus case. |
| `cargo test -p cabal-engine --test datc -- --nocapture` | 171/171 original DATC cases; no skipped cases. Corpus JSON byte-for-byte unchanged from HEAD. |
| `cargo test -p cabal-engine --test oracle -- --nocapture` | 20/20 full-state cases; no skipped cases. |
| `cargo clippy --workspace --all-targets -- -D warnings` | Pass. |
| `WASM_PACK_CACHE=/private/tmp/cabal-wasm-cache pnpm engine:build` | Pass. Existing cached wasm-bindgen/wasm-opt executables copied to the writable cache after an installation attempt hit read-only Cargo cache permissions. |
| `WRANGLER_LOG_PATH=/private/tmp/cabal-wrangler.log pnpm check` | Typecheck and lint pass; 60 TypeScript tests pass, including 13 real-WASM engine tests. |
| API audit | All original public WASM function names preserved; Rust parse, legal and movement resolver signatures preserved. |

Full local logs: `/private/tmp/cabal-test.log`, `/private/tmp/cabal-clippy.log`,
`/private/tmp/cabal-datc.log`, `/private/tmp/cabal-wasm-build.log`,
`/private/tmp/cabal-pnpm-check.log`.

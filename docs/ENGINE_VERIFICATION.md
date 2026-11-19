# Engine verification

How the adjudicator is checked beyond the DATC corpus: the independent
position oracle, order normalisation, the explanation graph and fuzzing.

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

The corpus is test-only data transcribed from godip, which is GPL-3.0. Its licence position and attribution are in
`crates/cabal-engine/data/NOTICE.md`.

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

### DATC 6.K

Issue #6 originally asked for DATC 6.K.1 and 6.K.2. The published
[DATC v3.0 specification](https://webdiplomacy.net/doc/DATC_v3_0.html) ends at
6.J.11 (sections A to J only), as does godip's `datc_v2.4_06.txt`, so those
identifiers do not exist. The issue scope was corrected; 6.B.15 and 6.C.8 are
carried here as full-state cases instead.

## Normalisation and explanations

`order::normalise(map, position, order)` uses the actual board unit, canonicalises
army destination coasts and inferred fleet coasts, and removes irrelevant
support destination coasts. Real but unreachable fleet coasts still fail.
DATC 4.B.5, 4.B.6, 4.C.1 and 4.C.2 have explicit-position tests; property tests
check normalisation idempotence. Resolver validation consumes the canonical order.

The additive WASM `Game.normaliseOrders` method is called by server adjudication
and browser sandbox adjudication/replay before `Game.process`. It retains illegal
and duplicate orders so resolver diagnostics remain available, and leaves lines
it cannot read untouched for `process` to report. Direct WASM
processing also normalises typed movement orders. Explicit power prefixes are
preserved. Existing exports and Rust parse/legal/resolver signatures remain.

`resolve_movement_with_dependencies` traces actual resolver queries, including
cached queries and cycles. Sorted nodes and edges produce deterministic Graphviz
DOT through `MovementDependencies::to_dot`. CLI `cabal explain --graph` emits a
standalone graph. WASM `Game.explain(index)` returns the trace for the movement
phase at that history index: `edges` index that phase outcome's `results`,
`dot` is the labelled graph, and `orders` and `cycles` hold the explanation
described below. It throws for retreat and
adjustment phases and for an index past the history. Rust corpus tests check
traced/untraced equivalence and permutation invariance; TypeScript tests
exercise normalisation, diagnostics, edges, DOT and JSON transport through the
real compiled WASM module.

### Verdicts, tolerant processing and explanations

`validate::validate_orders` gives one verdict per submitted line for the current
phase: canonical text, `legal`, a machine code and a sentence. It asks the
question the resolvers ask (the movement check is `order::normalise` itself;
retreats and adjustments are run through their resolver), so a line is legal
exactly when adjudication would not throw it out. TypeScript tests hold that
equivalence against the compiled module: every order from `Game.legal` is
judged legal, and every order judged illegal comes back from adjudication as
`illegal` with the same reason code.

`Game.process` does not reject a phase over one order. A line that cannot be
read, names another power, is the wrong kind for the phase or is for a unit the
power does not have is returned in `rejected`; the rest are adjudicated. An
order for another power's unit is dropped before duplicates are counted
(DATC 6.A.6). Before that was pinned by `tests/foreign_orders.rs`, a second
order for a rival's unit made the rival's own order a duplicate and the unit
held, so any power could cancel any move.

`explain_movement` returns, next to the trace, the numbers of DATC 5.B for
every order (attack strength, the hold or defend strength it met, the prevent
strength of each rival move), which supports counted and which units cut the
others, the fleets of a convoy and what broke it, and the cycle a backup rule
settled. `text::explain_sentence` turns that into one sentence with units named
in full. `tests/explain.rs` covers each failure code (`bounce`, `repelled`,
`head_to_head`, `own_unit`, `no_path`, `cut`, `void`, `dislodged`, `paradox`,
`illegal`), asserts that explaining never changes a ruling, and checks the
sentences word for word. WASM `Game.explain(index)` carries all of it per
result; `Game.explainPreview(orders)` and `explainPreview(state, orders)` do the
same for orders nobody has submitted, without touching the game.

Measured costs are in [PERFORMANCE.md](PERFORMANCE.md).

## Fuzzing and checks

The parser target calls `parse::parse` on arbitrary byte input decoded as lossy
UTF-8, checks serialization and attempts all three phase conversions. The
movement target generates valid sparse or initial positions and selects a legal
order for every unit, then calls `resolve_movement` and checks idempotence,
permutation invariance, conservation, ownership, and unique occupation.
`fuzz/Cargo.toml` isolates nightly fuzz dependencies from the stable workspace.
The scheduled stress workflow has separate parser/movement matrix jobs, each
with `-max_total_time=600`, `fail-fast: false`, and crash artifact upload.

## Saved games, replay and restore

A saved game is the MILA / Cicero layout plus two optional `cabal` blocks that
other readers ignore. On the game: engine version, the full rulebook, the
outcome (a solo, or a draw with its members) and the pledges with their
receipts. On each retreat-phase state: where every dislodged unit was attacked
from, whether by convoy, and which provinces saw a standoff. Press travels in
each phase's `messages`, as in MILA. Files without the blocks still load.

There are three ways to load one, and they differ in how much they trust it.

| Operation | Rust | WebAssembly | Adjudicates | Use it for |
|---|---|---|---|---|
| Verify | `Game::verify_saved` | `verifySaved(json)` | every phase | Auditing a record. Returns a report listing every divergence; never fails because of one. |
| Replay | `Game::from_saved` | `Game.fromSaved(json)` | every phase | Importing someone else's file. Fails at the first phase whose units or centres differ. |
| Resume | `Game::resume`, `Game::from_snapshot` | `Game.resume(json)`, `Game.fromSnapshot(snapshot, saved?)` | nothing (a snapshot replays only a tail recorded after it) | Restoring your own storage. |

Resume exists because replay couples every stored game to today's rulings. A
Durable Object used to wake by replaying its whole history, so shipping a
corrected ruling could stop a game in flight from ever loading again. A resumed
game keeps earlier phases verbatim as an archive and continues from the last
recorded state. `Game.snapshot()` is the constant-size form of that state for
hosts that do not want to parse the whole save to wake.

`verify_saved` compares, per phase: the orders as adjudicated, result codes,
dislodged units with attacker origins and standoffs, phase names, units,
centres, retreat options, build allowances, and finally the outcome. After a
difference in the board it continues from the recorded state, so one bad phase
is reported once. Files with the `cabal` block are held to an exact standard
that ends with comparing the re-exported game with the file. Files from other
tools are compared on what they record: they may omit implicit holds, order
their lists differently, leave results empty, and count builds the MILA way
(capped at the free build sites).

`cabal replay <file or directory>...` runs it from the command line and exits 1
on any divergence; CI runs it over `crates/cabal-engine/tests/data/games`. That
directory and its three fixture tiers are described in its own `README.md`.

## What the DATC harness checks

A DATC case states, per order, whether it succeeds. Checking only that let a
wrong standoff list through, because nothing looked at the lists.
`tests/datc_harness` (shared by `cargo test` and `cabal datc`) now also checks
the dislodgements those expectations imply, that the dislodged list, attacker
origins, standoff list and resulting position follow from the outcomes, and in
retreat cases that `legal_retreats` and the resolver agree and that a successful
retreat actually lands. 171 cases produce 1,639 assertions; 336 orders have no
expectation in the corpus and are counted as skipped. The same consistency
check runs as a property test over random crowded boards.

`tests/data/cabal_cases.json` holds Cabal's own cases in the same layout with
explicit `dislodged`, `standoffs` and `retreats` lists, starting with the
ruling that was wrong: when two units bounce in a province and both are
dislodged from elsewhere, that province is still a standoff.

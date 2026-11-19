# Replay fixtures

Saved games the engine must replay with zero divergences. Three tiers, because
each proves something the others cannot.

| Tier | Where | What it proves |
|---|---|---|
| 1. Property | no files: `tests/roundtrip.rs` | Any game the engine can play survives export and every way of loading it (strict replay, verification, trusted resume, snapshot, a save cut to start in a retreat phase). Seeded, so a failure names its game. |
| 2. Generated | `generated/` | Today's rulings, pinned byte for byte. Each file is written by `tests/common/golden.rs` from a script or a seed. A change to any recorded ruling fails `tests/replay.rs` with the file named. |
| 3. Recorded and external | `recorded/`, `external/` | Agreement with adjudication that Cabal did not write. `external/` holds games published by other projects; `recorded/` is for games played on Cabal itself. |

`manifest.json` lists every file with its source, licence, engine version,
phase count and the mechanics it covers. The test recomputes the phase count and
coverage and compares them, and it fails if a file is missing from the manifest
or a listed file is missing from disk. Between them the fixtures must cover:
bounces, supports, convoys, dislodgements, standoffs, retreats (successful,
colliding, disbanded), builds, waives, disbands, civil disorder, eliminations, a
solo, a draw, split coasts, press, pledges with receipts, the 1971, 1982 and
DPTG rulebooks, a short-victory variant, the `duel` map with build-anywhere, and
a save that begins in a retreat phase.

## Running

```sh
cargo test -p cabal-engine --test replay --test roundtrip
cargo run -p cabal-cli -- replay crates/cabal-engine/tests/data/games   # what CI runs
```

`cabal replay` prints one line per game, ending in `N phases, 0 divergences`,
and exits 1 if any game diverges. Add `--json` for a machine-readable report.

## After an intended rules change

```sh
UPDATE_FIXTURES=1 cargo test -p cabal-engine --test replay
git diff crates/cabal-engine/tests/data/games
```

Files are written one phase per line, so the diff shows exactly which recorded
rulings moved. Recorded and external games are never rewritten; if one of them
starts to diverge, the engine changed a ruling that some other adjudicator
made differently, and that needs a decision, not a regeneration.

## External games

`external/cicero_433761.json` is the complete 35-phase game `game_433761_ENGLAND_AG`
from the redacted games Meta released with Cicero (MIT licence). States, orders
and results are as published; messages and logs are removed. The published file
names no rulebook. `rules` is set to `1982` here because the recorded Winter
1908 removals (France, three units, one centre, no orders) match civil disorder
measured to home centres, the pre-2023 rule; under the 2023 rule a different
army survives, which `tests/cicero_import.rs` pins as a test. The published
`results` are empty in every phase, so this game checks positions, retreat
options and build allowances across 35 phases, but not result codes.

## Recorded games

None yet. The one finished production game known when this set was built
(`SFKGJ8`) was no longer retrievable from `GET /api/games/SFKGJ8/replay`. To add
one: save the response of that endpoint (or the sandbox export) under
`recorded/`, add a manifest entry with `tier: "recorded"`, its source and
licence, then run the update command above to fill in the computed fields.

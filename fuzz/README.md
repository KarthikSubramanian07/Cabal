Run from the repository root with nightly Rust and cargo-fuzz installed:

```sh
cargo +nightly fuzz run parser -- -max_total_time=600 -max_len=4096
cargo +nightly fuzz run movement -- -max_total_time=600 -max_len=256
cargo +nightly fuzz run saved -- -max_total_time=600 -max_len=16384
cargo +nightly fuzz run validate -- -max_total_time=600 -max_len=4096
cargo +nightly fuzz run record -- -max_total_time=600 -max_len=4096
```

The parser target accepts arbitrary bytes, exercises phase conversions, and checks
parsed-order serialization. The movement target selects one legal order per unit
on either the initial board or a generated valid sparse board. It checks
normalisation idempotence, submission and unit permutation invariance, ownership
preservation, unit conservation, and unique occupation. The saved target parses
arbitrary bytes as a saved game and runs every loader on it (`verify_saved`,
`from_saved`, `resume`, `from_snapshot`): none may panic, and whatever
`from_saved` accepts must re-export to a file that replays with zero divergences.
Its seeds are four small golden games from `tests/data/games/generated` and `year_0950.json`, an input it found whose export did not read back (a state named `S0950M` was written back as `S950M`), kept so it is tried first. The validate
target reads arbitrary text as the lines a player typed, in any phase kind, on the opening
or a generated board: one verdict per line, a reason on each, canonical text that validates
to itself, and in movement phases the same answer the resolver then gives for every unit.
The record target turns bytes into orders of every kind, legal or not, for any power and
any province, plays up to twelve phases with them, and requires the game it recorded to
verify clean, replay to the same position and read back the same rulings after a resume. Inputs are bounded to keep
individual runs useful. The scheduled Stress workflow runs each target separately
for 600 seconds and uploads crash artifacts even on failure.

Named seed inputs are versioned. Automatically discovered SHA-1-named inputs,
crash artifacts, and coverage output stay local; no existing corpus files are
deleted. Promote a useful regression to a named seed and a focused test after
investigating it.

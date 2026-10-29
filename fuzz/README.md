Run from the repository root with nightly Rust and cargo-fuzz installed:

```sh
cargo +nightly fuzz run parser -- -max_total_time=600 -max_len=4096
cargo +nightly fuzz run movement -- -max_total_time=600 -max_len=256
```

The parser target accepts arbitrary bytes, exercises phase conversions, and checks
parsed-order serialization. The movement target selects one legal order per unit
on either the initial board or a generated valid sparse board. It checks
normalisation idempotence, submission and unit permutation invariance, ownership
preservation, unit conservation, and unique occupation. Inputs are bounded to keep
individual runs useful. The scheduled Stress workflow runs each target separately
for 600 seconds and uploads crash artifacts even on failure.

Named seed inputs are versioned. Automatically discovered SHA-1-named inputs,
crash artifacts, and coverage output stay local; no existing corpus files are
deleted. Promote a useful regression to a named seed and a focused test after
investigating it.

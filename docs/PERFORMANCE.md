# Engine performance

What the engine costs, how that is measured, and what CI holds it to. Every
number here was measured, on the machine and the commit stated; nothing is an
estimate. Rerun the commands before quoting a number elsewhere.

## How to measure

```sh
# native, Criterion
cargo bench -p cabal-engine --bench adjudicate
python3 tools/check-bench-regression.py            # against benches/baseline.json

# through the wasm boundary, as the browser and the Worker pay it
pnpm engine:build
node packages/engine/bench/wasm-bench.mjs          # add --json for a machine-readable report
node packages/engine/bench/wasm-bench.mjs path/to/another/pkg

# size, the way CI gates it
gzip -c packages/engine/pkg/cabal_engine_bg.wasm | wc -c
```

`wasm-bench.mjs` reports the fastest of 40 rounds for every call. On a shared
machine the minimum is the only statistic that measures the code rather than
the neighbours; the numbers below were taken on an Apple M1 that other jobs
were using, which is exactly the situation the minimum is for. Calls an older
build lacks are reported as `n/a`, so one script compares builds across an API
change. Cold start figures are the median of seven fresh Node processes.

## What CI gates

| Gate | Where | Limit |
|---|---|---|
| Opening adjudication (22 units) | `bench` job | 30 percent slower than the base commit, same runner |
| Legal orders, all powers, fleet-heavy midgame, one power at a time | `bench` job | same |
| Legal orders, all powers, fleet-heavy midgame, shared convoy search | `bench` job | same |
| Engine wasm, gzip | `wasm` job, `WASM_SIZE_BUDGET_BYTES` | 409,000 bytes, about 6 percent above the build |
| Worker bundle, gzip | `deploy-dry-run` job | 786,432 bytes (measured 755,828) |

The base commit and the change are benchmarked back to back on one runner,
because shared runners differ from one another by far more than 30 percent. A
benchmark the base commit does not have yet is reported and skipped.

## Before and after: correctness and API work of November 2026

"Before" is the branch at `14e48cd` (replay fidelity work, before any of the
changes below); "after" is the head of the same branch. Node 24, Rust 1.97.0.

### Start-up

`Map::standard()` used to parse and validate 33.5 KB of JSON the first time
anything touched the engine. `build.rs` now runs the bundled map documents
through `Map::from_json` at compile time and writes the validated result as
static tables, which the engine copies.

| Measurement | Before | After | |
|---|---|---|---|
| Standard map, native (Criterion mean) | 184.3 us | 18.4 us | 10.0 times faster |
| First `new Game()` in a fresh wasm instance (median of 7) | 4.67 ms | 1.54 ms | 3.0 times faster |
| `WebAssembly.Module` compile | 1.76 ms | 1.80 ms | unchanged |
| wasm-bindgen `init` | 19.3 ms | 18.3 ms | unchanged |
| First `process` (cold code) | 5.25 ms | 5.36 ms | unchanged |

A warm `new Game()` takes 1.3 us, so what is left of the first one is one-off
start-up in the host plus copying the tables, not work the engine repeats. These are Node figures; issue #61
asks for the same in workerd, which is the server track's harness.

### Legal orders

The fleet-heavy midgame board (34 units, 18 fleets at sea, 4,292 legal orders)
is the worst case and the one the composer and the bots hit. Three things
changed: the convoy search is shared by all seven powers instead of repeated
for each (`legal_movement_all`), order text is written by a batch formatter
that names each unit once (`OrderTexts`), and large results cross the boundary
as one JSON string instead of object by object.

Native (Criterion mean):

| Measurement | Before | After | |
|---|---|---|---|
| Find every legal order, all powers | 1,362 us (seven searches) | 401 us (one search) | 3.4 times faster |
| Write the text of those 4,292 orders | 1,776 us | 211 us | 8.4 times faster |
| Both together | 3,138 us | 612 us | 5.1 times faster |
| One unit (`legal_movement_for`) | no such call | 167 us | |
| Every unit as structured options | no such call | 439 us | |

Through wasm (fastest of 40 rounds):

| Call | Before | After | |
|---|---|---|---|
| `game.legal(power)` for seven powers, midgame | 4,488 us | 2,305 us | 1.9 times faster |
| `game.legalAll()`, midgame | no such call | 1,113 us | 4.0 times faster than the seven calls it replaces |
| `game.legalMoves()`, midgame, structured | no such call | 1,172 us | |
| `game.legalMoves("ENGLAND")`, midgame | no such call | 400 us | |
| `game.legal(power)` for seven powers, opening | 236 us | 167 us | 1.4 times faster |

The research prototype for the shared search measured 4.1 times; the committed
version measures 3.4 natively and 4.0 through wasm once text is included. What
remains is the chordless convoy-route walk itself, which bitsets would speed up
and which nobody waits on at 0.4 ms.

### Adjudication, what-if and explanations

| Call | Before | After |
|---|---|---|
| Opening adjudication, native, interleaved with `main` five times, fastest | 12.69 us | 12.76 us |
| Pandin's paradox, native, same method | 5.25 us | 5.20 us |
| Opening adjudication with the full explanation, native | no such call | 16.2 us |
| `preview(state, orders)`, opening, 22 orders | 181 to 198 us | 162 to 207 us |
| `game.preview(orders)` (no state sent across) | no such call | 122 to 136 us |
| `game.explainPreview(orders)` | no such call | 167 to 170 us |
| `game.validateOrders(power, three orders)` | no such call | 11 us |
| `toSaved`, 40 phases | 1,034 us | 1,052 us |
| `Game.resume`, 40 phases | 942 us | 965 us |
| `Game.fromSaved`, 40 phases | 2,673 us | 2,667 us |

Explaining a phase costs about a quarter more than adjudicating it, so
explanations stay on demand (`explain`, `explainPreview`) and `process` does
not compute them.

### Size and the optimisation level

| Build | Raw | gzip | brotli |
|---|---|---|---|
| Before (`14e48cd`) | 796,133 | 289,382 | 220,035 |
| After, shipped (`opt-level = 3`, fat LTO, one codegen unit, `panic = "abort"`, `wasm-opt -Oz`) | 854,820 | 321,347 | 244,269 |
| After, with the heuristic bot merged from `main` | 996,836 | 372,566 | 281,963 |
| After the review fixes (submitted-order record, saved rejections, map choice, tolerant `cabal` block) | 1,026,287 | 384,183 | 289,987 |

The new API (verdicts, explanations, structured moves, build info) costs
32 KB gzip, and the bot (`cabal-bot`, merged separately) another 50 KB;
baking the maps and dropping the map JSON parser from the binary paid back
part of what the API added.

The review fixes added 12 KB gzip. Reading a host's `cabal` block through
`serde_json::Value` would have cost another 12 KB for the `Value`
deserializer alone, so the block is kept as raw text and read part by part
with the parser that is already in the binary.

The engine is most of the Worker's upload, so its growth moved the Worker
bundle from 642,074 to 755,828 bytes gzip and past the 655,360 budget that job
had; the budget is now 786,432. No optimisation level brings the bundle back
under the old figure (`"z"` saves about 72 KB of the 87 KB needed and costs the
most speed), so this is a real cost of the new API, paid in isolate start-up,
and the first thing to revisit if issue #61's workerd measurements say start-up
matters. Replay verification (`verify_saved`) is code the Worker never calls
and the first candidate for a feature gate; its share of the binary was not
measured.

The size-oriented settings were measured and **not adopted**, because the rule
was to switch only if nothing got meaningfully slower:

| Variant | gzip | Change | Speed against the shipped build |
|---|---|---|---|
| `opt-level = 3` (shipped) | 315,490 | | |
| `opt-level = 2` | 309,870 | -1.8% | within 4 percent on every call except `new Game()`, which is under 2 us either way |
| `opt-level = "s"` | 278,854 | -11.6% | 7 to 20 percent slower on previews, validation, legal orders and restores; `toSaved` 62 percent slower |
| `opt-level = "z"` | 254,415 | -19.4% | 17 to 97 percent slower |
| dependencies and glue at `"s"`, engine at 3 | 307,686 | -2.5% | 4 to 21 percent slower; `toSaved` 51 percent slower |
| dependencies and glue at `"z"`, engine at 3 | 303,836 | -3.7% | 4 to 29 percent slower; `toSaved` 57 percent slower |

(Variants were built before the JSON hand-off landed, hence 315,490 rather
than 321,347 for the shipped settings; the comparison is like for like.)

`wasm-opt` flags make no difference worth having on this binary: `-Oz`, `-Os`,
`-O3`, `-O4`, `-Oz --converge` and `-Oz --strip-producers` all land between
321,249 and 322,144 bytes gzip, and their run-time differences were inside the
noise.

LTO, one codegen unit and `panic = "abort"` were already on. The WebAssembly
build now has its own cargo profile, `wasm-release`, wired into
`pnpm engine:build` and CI. It inherits `release` unchanged; if a smaller
binary is ever worth 15 percent, it is one line there and the native benches
keep `opt-level = 3`.

A function-level size profile (`twiggy`) shows no single large item: the
biggest function is under 0.6 percent of the unstripped binary. An earlier
experiment replacing stable sorts with unstable ones made the binary larger.

## Recorded baseline

`crates/cabal-engine/benches/baseline.json` holds the numbers
`tools/check-bench-regression.py` falls back to when it is run without a
same-machine baseline. They are for local sanity checks only; CI never
compares against them.

## Board motion (web, November 2026)

A resolved phase plays on the board: pieces march, bounce, are knocked aside and are built, the
order marks ink in and failures are stamped. The budget is 60 frames a second on a mid-range
phone, with no layout thrash. `apps/web/scripts/motion-perf.mjs` measures it: a Pixel 7 page in
headless Chromium, the CPU throttled through the DevTools protocol, a busy spring phase (twenty
orders across all seven powers, with bounces, a support and a standoff), frames timed with
`requestAnimationFrame` from the frame after the click to 2.6 seconds.

| Run (2026-11-19, Apple Silicon, headless Chromium 158) | fps | median frame | p95 frame | frames over 25 ms | forced layouts |
|---|---|---|---|---|---|
| 4x CPU throttling | 57.5 | 16.7 ms | 16.8 ms | 3 of 116 | |
| No throttling, traced | 56.5 | 16.7 ms | 16.8 ms | 2 of 96 | 0 |
| 4x CPU throttling, reduced motion | 54 | 16.7 ms | 16.7 ms | 2 of 108 | |

What made it fast:

- Pieces and marks live on their own composited layer (`svg.board-live`) over the map, so a
  frame repaints a few dozen small shapes, never the 380 KB of province outlines.
- Pieces move by Web Animations on `transform` and `opacity` only. The SVG still lays out its own
  small subtree each frame (about 0.7 ms at 4x throttling); nothing reads layout from script while
  they run, and the trace shows no forced layouts.
- Each mark's ink mask covers only the mark. The first version gave every mask the whole board,
  one full-size offscreen surface per order: the same phase ran at 12.7 fps at 4x throttling,
  with a 95th percentile frame of 217 ms.
- The click that adjudicates costs one long frame (about 170 ms at 4x throttling: the engine,
  React rendering the results and the choreography being planned). Everything after it is steady.

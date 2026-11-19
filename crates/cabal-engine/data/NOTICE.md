# Data attribution

Cabal's code is MIT licensed (see `LICENSE` at the repository root). This file lists every data file in this crate that was derived from someone else's work, where it came from, under what licence, and why it is compatible with the MIT licence.

## Shipped data (compiled into the engine, the wasm module and every build)

### `maps/standard.json`

Describes the classic 1901 Diplomacy map (75 playable provinces plus impassable Switzerland, 81 regions, 218 borders).

- Its province and region tables are derived from [TedDriggs/diplomacy](https://github.com/TedDriggs/diplomacy) (MIT License, Copyright (c) 2025 Ted Driggs) and used here under the same licence.
- Its border table was regenerated from the adjacency facts of the standard Diplomacy board, as encoded by [zond/godip](https://github.com/zond/godip) (GPL-3.0) and cross-checked against the MILA `standard.map` (AGPL-3.0). Which province touches which is a fact about a published game board, not expression, so no code, file or text was copied from either project; only the list of borders was checked against them. The upstream MIT table was missing nine edges (for example Gulf of Bothnia to St Petersburg south coast).

### `maps/duel.json`

A three-province test variant written for Cabal. Original work, MIT like the rest of the repository.

## Test data (never compiled into the engine library, the wasm module, the Worker or the web app)

### `../tests/data/datc_v3.json`

Read by `cargo test` and embedded in the `cabal` command line tool (for `cabal datc`). Encodes the Diplomacy Adjudicator Test Cases v3.0 by Lucas B. Kruijswijk (https://webdiplomacy.net/doc/DATC_v3_0.html), in the JSON layout of [TedDriggs/diplomacy](https://github.com/TedDriggs/diplomacy) (MIT License, Copyright (c) 2025 Ted Driggs), with expectations corrected to the DATC's stated preferences where the upstream file marked cases as ignored or errata (6.B.7, 6.B.8, 6.B.10, 6.B.12, 6.B.15, 6.G.19, 6.H.1, 6.H.2, 6.H.3).

### `../tests/data/oracle_godip.json` (godip-derived oracle corpus)

- **Source:** [zond/godip](https://github.com/zond/godip), commit `cd244421928227a806808b51848ad290f88017fc`, files `variants/classical/datc/dipai.txt`, `real.txt`, `droidippy_errors.txt` and `diplicity_errors.txt`. Eighteen of its twenty cases are transcribed from those files; the other two are DATC v3.0 cases 6.B.15 and 6.C.8 written out as full positions. Each entry records its upstream path, case name, commit, immutable source URL and the SHA-256 of the source file.
- **Licence of the source:** GNU General Public License v3.0 (godip's `LICENSE`). Copyright the godip authors.
- **What was taken:** for each case, the units on the board, the orders, and the expected units, dislodgements and supply centre owners afterwards. These are records of game positions and of what the rules of Diplomacy say happens to them. No godip source code, test harness, parser or prose was copied; the JSON layout, the runner (`../tests/oracle.rs`) and the checker (`tools/check_godip_oracle.py`) are Cabal's own.
- **Why this is compatible with the MIT licence:** copyright protects expression, not facts. A position and its adjudicated result are facts about a game, in the same way the DATC's cases are; several of these cases record positions from real games played on other sites. The transcription keeps none of godip's code or wording, so we treat it as unencumbered factual data and distribute it with the rest of the repository.
- **Isolation, in case anyone disagrees:** the file is test-only. It is read with `include_str!` by one integration test and by the checker script, and is not part of the engine library, the wasm module, the npm package, the Worker bundle or the web app, so no shipped artefact contains it. If the godip authors ask, or if the analysis above is ever found wrong, the file can be deleted (with `../tests/oracle.rs` and the checker) without changing any shipped behaviour. To the extent any of its content is found to be copyrightable expression of the godip authors, that content is offered under GPL-3.0, not under Cabal's MIT licence. The crate is not published to crates.io.

### `../tests/data/games/external/cicero_433761.json`

The complete 36-phase record (35 adjudicated) of the publicly released Cicero redacted game `game_433761_ENGLAND_AG.json`, with messages and logs removed and `rules` set to `1982` (see `../tests/data/games/README.md` for why), from [facebookresearch/diplomacy_cicero](https://github.com/facebookresearch/diplomacy_cicero/blob/main/data/cicero_redacted_games/game_433761_ENGLAND_AG.json). That repository is MIT licensed outside its `fairdiplomacy_external` directory, which this file does not come from:

> MIT License. Copyright (c) Meta, Inc. and its affiliates.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

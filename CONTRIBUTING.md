# Contributing

## Setup

```sh
rustup show                 # picks up rust-toolchain.toml (1.97, wasm32 target)
cargo install wasm-pack     # 0.15+
corepack enable && pnpm install
pnpm engine:build           # builds the wasm package into packages/engine/pkg
pnpm dev                    # web on :5173, server on :8787
```

## Layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Rust in `crates/`, TypeScript packages in `packages/`, deployables in `apps/`.

## Checks before a PR

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm check
```

## Conventions

- Conventional commit subjects, imperative mood: `feat(engine): resolve convoy paradoxes with Szykman rule`.
- One concern per PR. Engine changes ship with DATC or property tests.
- No em dashes or en dashes anywhere (code, docs, commits). Use colons, commas or parentheses.
- Rules questions are settled by DATC v3.0 first and [docs/RULES.md](docs/RULES.md) second. If you need to change a rule choice, write an ADR.
- Every order outcome must carry an explanation. Booleans are not enough.

## Issue etiquette

Phase 1 work is tracked as seven issues, one per engineer, grouped into three subteams (Adjudicators, Couriers, Cartographers). Start with [docs/ONBOARDING.md](docs/ONBOARDING.md). Each issue states scope, non-goals, the interfaces it must honour and its test plan. Claim it by assigning yourself, keep the checklist updated, and open PRs early as drafts.

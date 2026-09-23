# Week 1: onboarding

Week 1 has no feature work. By Friday everyone should have played real Diplomacy, have Cabal running locally, understand the part of the repo they own, and have posted a plan on their issue.

## 1. Play Diplomacy on Backstabbr

Cabal only makes sense once you have been lied to on a real board.

- [ ] Sign in at [backstabbr.com](https://backstabbr.com) and join the team's private game from the invite link. One power each, seven of us.
- [ ] Open a **Sandbox** first and try every order: click a unit then its destination to move, click it twice to hold, press <kbd>S</kbd> to support and <kbd>C</kbd> to convoy.
- [ ] Read the [how to play](https://backstabbr.com/how-to-play) page and the [site rules](https://backstabbr.com/site-rules).
- [ ] Send at least one message from the **Press** tab before the first deadline. Make a promise. Decide later whether to keep it.
- [ ] Submit orders every phase. Missed orders mean your units just hold.
- [ ] Write down one thing Backstabbr does well and one thing that annoyed you. Bring both to the week 1 wrap up. They are product research for Cabal.

## 2. Get the repo running

- [ ] Follow [CONTRIBUTING.md](../CONTRIBUTING.md) setup: Rust toolchain, wasm-pack, pnpm, `pnpm engine:build`, `pnpm dev`.
- [ ] Run the checks: `cargo test --workspace` and `pnpm check`. Both should be green on `main`.
- [ ] Play a full Spring and Fall 1901 in the local sandbox, then on [playcabal.pages.dev](https://playcabal.pages.dev), and compare it with Backstabbr.
- [ ] Try `cargo run -p cabal-cli -- explain "ENG: F NTH - HOL" "ENG: A BEL S F NTH - HOL"`.

## 3. Read for your subteam

Everyone reads the [README](../README.md) and [PLAN.md](PLAN.md). Then:

| Subteam | Issues | Read |
|---|---|---|
| **Adjudicators** (rules and AI players) | #6, #7, #11 | [RULES.md](RULES.md), [ARCHITECTURE.md](ARCHITECTURE.md) sections 3, 4 and 7, `crates/cabal-engine`, the DATC report, `packages/agents` |
| **Couriers** (server, platform, integrations) | #8, #12 | [PROTOCOL.md](PROTOCOL.md), [ARCHITECTURE.md](ARCHITECTURE.md) sections 5, 6, 9 and 10, `apps/server`, `packages/protocol`, `.github/workflows` |
| **Cartographers** (board, press, player experience) | #9, #10 | [ARCHITECTURE.md](ARCHITECTURE.md) section 8, [BRAND.md](BRAND.md), `apps/web`, `tools/mapgen`, the e2e tests |

## 4. Plan your issue

Post the plan as a comment on your issue by the end of the week:

- [ ] **Approach**: how you will build it, in a few paragraphs. Link any open source you studied first.
- [ ] **Pull requests**: the scope split into small PRs, in order, each one mergeable on its own. Your issue is a track that lands over the whole phase, not something to resolve in one PR or one week, so a list of eight to fifteen small PRs is normal.
- [ ] **Interfaces**: what you need from other issues and what they need from you. Tag those owners.
- [ ] **Risks and questions**: anything unclear in the scope, and anything you think should be cut or added.
- [ ] **First PR**: open it as a draft, even if it only adds a failing test or a stub. Every PR says `Part of #N` in its description; only the last one, the one that meets the exit criteria, says `Closes #N`.

## Subteam rituals

- Each subteam reviews its own pull requests. Cross-team interface changes (protocol frames, the wasm surface, the GameRoom summary) need a reviewer from the consuming team.
- Keep your issue checklist current. A short async update in the issue once a week beats a meeting.

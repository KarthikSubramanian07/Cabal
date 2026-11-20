# Contributing

## Setup

```sh
rustup show                 # picks up rust-toolchain.toml (1.97, wasm32 target)
cargo install wasm-pack     # 0.15+
corepack enable && pnpm install
pnpm engine:build           # builds the wasm package into packages/engine/pkg
pnpm dev                    # web on :5173, server on :8787
```

### Git identity (so your commits count)

GitHub only credits a commit to you if its author email belongs to your account. Without this step git invents an address from your machine or the campus wifi hostname, and your work will not show under your name or in the contributors list. Run this once, using the noreply address from [github.com/settings/emails](https://github.com/settings/emails):

```sh
git config --global user.name "Your Name"
git config --global user.email "12345678+your-username@users.noreply.github.com"
git config user.email       # check it before your first commit
```

## Layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Rust in `crates/`, TypeScript packages in `packages/`, deployables in `apps/`.

## Checks before a PR

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm check
pnpm test:e2e          # Playwright against the built site, no server
pnpm test:e2e:live     # the site against cabal-server under wrangler dev, if you touched apps/web or the API
```

`pnpm test:e2e:live` applies the D1 migrations to a local database, starts `wrangler dev` for
`apps/server` on port 8799 and `vite preview` of the built site on port 4184 with `/api` and the game
sockets proxied to it, then plays the front door, the lobby, whole turns and a game with several
browser contexts, on a desktop and on a phone. It needs `pnpm engine:build` first. Move the ports with `LIVE_SERVER_PORT` and
`E2E_LIVE_PORT` when another checkout holds them.

CI also runs a deploy dry run on every pull request: it bundles `apps/server` with `wrangler deploy --dry-run` (no credentials, nothing uploaded) and fails if the gzipped Worker bundle is over its budget. To reproduce it locally after `pnpm engine:build`:

```sh
pnpm --filter @cabal/server run engine:sync
pnpm --filter @cabal/server exec wrangler deploy --dry-run --outdir /tmp/cabal-dry-run
```

## Deploying

Deploys are manual, run by a maintainer from their own machine, and CI holds no Cloudflare credentials. The reasons and the conditions for revisiting that are in [ADR 0008](docs/adr/0008-manual-wrangler-deploys.md). Contributors never need to deploy; merging to `main` does not deploy anything.

| What | Name | URL |
|---|---|---|
| Web app | Pages project `playcabal` | https://playcabal.pages.dev |
| API and Durable Objects | Worker `cabal-server` | https://cabal-server.karthik-e5e.workers.dev |
| Cloudflare account | id `e5e342f3ca2f33158f6f1dd40c039be0` | |

### Once per machine

```sh
npx wrangler login            # opens a browser; sign in to the account above
npx wrangler whoami           # must list account e5e342f3ca2f33158f6f1dd40c039be0
```

If your login can see more than one account, wrangler asks which to use. Answer it, or set `export CLOUDFLARE_ACCOUNT_ID=e5e342f3ca2f33158f6f1dd40c039be0` for the shell. The account id is not a secret, but never put an API token in the repository, in `.env` files that are committed, or in GitHub secrets.

### Production deploy

1. Start from an up to date `main` with no local changes: `git switch main && git pull --ff-only && git status`.
2. Check that CI is green for that exact commit: `gh run list --branch main --limit 1` (or the badge on the README). Do not deploy a red or still-running commit.
3. If the commits since the last deploy add a Durable Object migration tag in `apps/server/wrangler.jsonc`, deploy that change on its own and read the migration notes below first. New D1 migrations (`apps/server/migrations/`) need nothing extra: `deploy:server` applies them to the remote `cabal` database before the Worker goes out.
4. Deploy:

   ```sh
   pnpm deploy:all       # server, then web (the site binds to the Worker); each builds the wasm engine first
   pnpm deploy:web       # only the site: builds apps/web and publishes dist to Pages, branch main
   pnpm deploy:server    # only the Worker: D1 migrations to the remote database, then wrangler deploy stamped with the commit
   ```

   Use `deploy:all`, not `pnpm deploy`: a bare `pnpm deploy` is a built-in pnpm command and does something else.
5. Check it (the health check):

   ```sh
   curl -s https://cabal-server.karthik-e5e.workers.dev/health          # {"ok":true,"protocol":2,"engine":"0.1.0","build":"<commit>",...}
   curl -s -o /dev/null -w '%{http_code}\n' https://playcabal.pages.dev/  # 200
   ```

   `/health` answers 503 with `ok: false` while the D1 index is unreachable or its schema is older than the build needs. `build` is the commit that is live: `deploy:server` stamps it as `BUILD_ID` (the first twelve characters of `git rev-parse HEAD`, with `-dirty` if the tree had uncommitted changes, which a production deploy never should), and tags the Worker version with it, so `wrangler deployments list` names it too. `version` is the Worker version id that `wrangler rollback` takes. Check that `build` matches `git rev-parse --short=12 HEAD`. Then open https://playcabal.pages.dev on a phone and a desktop and play one order.

### Preview deploys

There are no automatic previews. To share a branch, build it and publish it to a Pages branch alias:

```sh
pnpm engine:build && pnpm --filter @cabal/web build
pnpm --filter @cabal/web exec wrangler pages deploy dist --project-name playcabal --branch <branch-name>
```

It is served at `https://<branch-name>.playcabal.pages.dev` (wrangler prints the exact URL). A preview site uses the production Worker; there is no preview Worker. Never pass `--branch main` for a preview, because that is the production branch.

### Rollback

- **Worker:** `pnpm --filter @cabal/server exec wrangler deployments list` shows recent deployments, and `pnpm --filter @cabal/server exec wrangler rollback [<version-id>] --message "<why>"` makes an older version live at once (with no id it goes back one version). Run `/health` again afterwards.
- **Site:** in the Cloudflare dashboard, open Workers & Pages, then `playcabal`, then Deployments, and choose "Rollback to this deployment" on the last good production deployment. `wrangler pages deployment list --project-name playcabal` lists them from the terminal.
- Then fix forward on `main` and deploy again, so `main` and production agree.

### Durable Object migrations

The `migrations` list in `apps/server/wrangler.jsonc` is applied once per tag and is never undone. Cloudflare refuses to roll back past a deploy that changed a Durable Object class (added, renamed or deleted one), so after such a deploy the only way out of a bug is a new forward deploy. Rollback never restores data stored inside an object. So:

- never edit or remove an existing migration tag; add a new one;
- a class rename or delete needs `renamed_classes` or `deleted_classes` in a new tag, and a delete destroys that class's data;
- schema migrations inside an object (its versioned SQL) should only add tables and columns, so that older code can still open newer storage.

### D1 migrations

The cross-game index is the D1 database `cabal` (binding `DB`). Its schema is the numbered files in `apps/server/migrations/`. Add a new file for every change and never edit one that has shipped. `pnpm dev` applies them to a local database, the test suites apply them to their own, and `pnpm deploy:server` applies them to the remote database before `wrangler deploy`, so a Worker never runs ahead of its schema. A Worker rollback does not roll a migration back, so a migration should only add tables, columns and indexes that older code can ignore. D1 Time Travel restores the database to any minute of the last 30 days, overwriting it in place: `wrangler d1 time-travel restore cabal --timestamp=<unix seconds>` prints a bookmark that undoes the restore.

## Conventions

- Conventional commit subjects, imperative mood: `feat(engine): resolve convoy paradoxes with Szykman rule`.
- One concern per PR. Engine changes ship with DATC or property tests.
- No em dashes or en dashes anywhere (code, docs, commits). Use colons, commas or parentheses.
- Rules questions are settled by DATC v3.0 first and [docs/RULES.md](docs/RULES.md) second. If you need to change a rule choice, write an ADR.
- Every order outcome must carry an explanation. Booleans are not enough.

## Issue etiquette

Phase 1 work is tracked as seven issues, one per engineer, grouped into three subteams (Adjudicators, Couriers, Cartographers). Start with [docs/ONBOARDING.md](docs/ONBOARDING.md). Each issue states scope, non-goals, the interfaces it must honour and its test plan. Claim it by assigning yourself and keep the checklist updated. An issue is a track landed as a series of small PRs over the phase, each mergeable on its own and marked `Part of #N`; nobody resolves one in a single PR or a single week, so open the first draft PR early and keep them coming.

# ADR 0008: Manual wrangler deploys, with a credential-free dry run in CI

Status: accepted (decided 2026-10-21, recorded 2026-11-18)

This ADR writes down a decision the owner made on 2026-10-21 and shipped in PR #38. It is recorded after the fact so that issue #12, issue #56, [ARCHITECTURE.md](../ARCHITECTURE.md) section 9 and [PLAN.md](../PLAN.md) all point at one source.

## Context

Cabal ships two deployables to one Cloudflare account (`e5e342f3ca2f33158f6f1dd40c039be0`): the Pages project `playcabal` (the web app) and the Worker `cabal-server` (the API and every Durable Object).

Until October 2026, `ci.yml` had `deploy-web` and `deploy-server` jobs that ran on every push to `main`. The repository never had a `CLOUDFLARE_API_TOKEN` secret, so both jobs skipped on every run and the workflow still showed green. Production fell a month behind `main` and nobody noticed. PR #38 removed the jobs and added `pnpm deploy:web`, `pnpm deploy:server` and `pnpm deploy:all`, which deploy from a maintainer's own `npx wrangler login`.

That left a contradiction. Issue #12 still asked for repository secrets and "zero-touch deploy on merge", while ARCHITECTURE section 9 said CI holds no Cloudflare credentials. Issue #56 asked for the choice to be written down.

The repository is public and has seven contributors who push branches to it directly. The project has one maintainer with Cloudflare access.

## Options

1. **Deploy on merge from CI.** Add a token scoped to Pages and Workers on this one account as a repository secret. `main` deploys on every merge, and branches in this repository (never forks) get preview deploys.
2. **Manual `pnpm deploy:all`, plus a dry run in CI.** The maintainer deploys from a green `main`. Every pull request runs `wrangler deploy --dry-run`, which bundles the Worker exactly as a real deploy would but needs no credentials and uploads nothing.
3. **A `workflow_dispatch` deploy job behind a protected GitHub environment.** The token lives in an environment secret, and a maintainer must approve each run.

## Decision

Option 2.

- CI holds no Cloudflare credential of any kind: no repository secret, no environment secret, no OIDC trust.
- The maintainer deploys with `pnpm deploy:all` (or `deploy:web` or `deploy:server` alone) from an up to date `main` with CI green. The runbook is in [CONTRIBUTING.md](../../CONTRIBUTING.md#deploying).
- The `deploy-dry-run` job in `ci.yml` runs on every pull request and every push to `main`. It bundles `apps/server` with `wrangler deploy --dry-run`, fails if bundling fails, and fails if the gzipped upload goes over a size budget. A broken `wrangler.jsonc`, a missing wasm module rule or a bundling error is then caught on the pull request, not during a production deploy.

## Why not the others

**Secrets in a public repository with many writers.** A repository secret is readable by any workflow that runs on a branch of this repository. Anyone with push access can add a step that prints it, encodes it, or sends it elsewhere, and GitHub's log masking only hides the exact string. Fork pull requests do not get secrets, but contributors here push branches to the main repository, so that protection does not apply. A token scoped to "Pages and Workers on one account" can still replace production, read every Durable Object through a new deploy, or delete the Worker. Holding no secret removes this whole class of risk.

**Option 3 is a better version of option 1, and is the upgrade path.** An environment secret with required reviewers is only exposed to jobs that a maintainer approves. It still needs branch protection to mean anything (below), and with one maintainer it adds an approval click to the same person who would otherwise type `pnpm deploy:all`. It earns its keep once there is a second person who should be able to deploy.

## Consequences

- **Deploys depend on one machine and one person.** If the maintainer is away, nothing ships. This is acceptable for a student project with a single owner.
- **Production can lag `main`.** This is the failure PR #38 was written to stop. A skipped deploy is now visible as a step a person did not take, rather than hidden behind a green check. It is still not measured: `/health` returns `{ ok: true }` and does not report a commit or engine version. Reporting the deployed commit from `/health` is the follow-up that makes "is production behind?" a single `curl` (tracked on #12, observability).
- **No automatic pull request previews.** A maintainer can publish one by hand with `wrangler pages deploy dist --project-name playcabal --branch <name>`, which serves it at `https://<name>.playcabal.pages.dev`. Preview Workers are not set up; a preview site talks to the production Worker.
- **Branch protection on `main` still matters.** The maintainer deploys whatever `main` holds, so a required green CI check and a required review on `main` are what stand between a bad merge and a bad deploy. The deploy runbook says to check CI on the exact commit before deploying.
- **Durable Object migrations are forward only.** The `migrations` list in `apps/server/wrangler.jsonc` (today tags `v1`, `new_sqlite_classes: ["GameRoom"]`, and `v2`, `new_sqlite_classes: ["Registry"]`) is applied once per tag and is never undone. Renaming or deleting a class needs its own new migration tag (`renamed_classes` or `deleted_classes`), and a deleted class loses its stored data. Cloudflare refuses `wrangler rollback` to any version older than the latest class lifecycle change, so once a deploy adds a migration tag the only way back is a new forward deploy that fixes the code. Even where rollback is allowed it restores Worker code only, never the SQLite data inside an object. A pull request that adds a migration tag (for example the `Registry` class in [ADR 0009](0009-registry-durable-object-instead-of-d1.md)) must say so in its description, and it should be deployed on its own, not batched with unrelated changes, as Cloudflare's documentation also advises.
- **Schema changes inside an object are also forward only.** Each object runs its own versioned SQL migrations on start. Code that rolls back must still be able to open storage that a newer version already migrated, so in-object migrations should only add tables and columns.

## How to revisit

Reopen this decision, and most likely move to option 3, when any of these becomes true:

- a second person needs to deploy;
- production is found more than seven days behind `main` while `main` had user-visible changes;
- the dry-run job and a real deploy disagree (the dry run passed and the real deploy failed for a reason a dry run could have caught).

Moving to option 3 means: a token scoped to `Workers Scripts: Edit` and `Pages: Edit` on this one account, stored as an environment secret on a `production` environment with the maintainer as required reviewer and `main` as the only allowed branch; branch protection on `main` requiring CI and one review; and a deploy job that runs the same `pnpm deploy:all` the runbook uses, so there is only ever one deploy path.

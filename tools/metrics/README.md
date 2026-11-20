# tools/metrics

One repeatable command for each phase 1 success metric in [docs/PLAN.md section 8](../../docs/PLAN.md#8-success-metrics-for-phase-1) (issue #57). Each one prints its figure, and with `--record <where>` writes it into [`metrics.json`](metrics.json) and the table in [`metrics.md`](metrics.md): metric, target, value, where it was measured, date, commit, and pass or fail.

| Metric | Target | Command |
|---|---|---|
| DATC v3.0 | 100 percent, zero skipped | `node tools/metrics/datc.mjs --record "local (cargo)"` |
| Full 7 seat game | finishes with no manual intervention | `node tools/metrics/full-game.mjs <origin> --record production` |
| Landing page to a game in progress | under 60 s | `METRICS_RECORD=production LIVE_ORIGIN=https://playcabal.pages.dev pnpm --filter @cabal/web test:e2e:live e2e-live/metrics.spec.ts` |
| Order submit round trip | p95 under 150 ms from Europe or North America | `node tools/metrics/order-rtt.mjs <origin> --record "production, from <city>"` |

`<origin>` is a deployment's web origin (`https://playcabal.pages.dev`, whose `/api` reaches the server) or a local `wrangler dev` (`http://localhost:8787`).

## What each one does

- **`datc.mjs`** runs `cabal datc --json` and passes when every DATC v3.0 case passed and none was skipped (a case is skipped when no assertion was evaluated for it). CI keeps the same JSON as the `datc` artefact on every run, and `apps/server/scripts/report-datc.mjs` posts it to a deployment's admin metrics.
- **`order-rtt.mjs`** makes an unlisted game with AI fill, binds the creator's seat with a `hello` frame, and times `n` (default 50) `orders.set` frames to their `orders.ack` by `id`, one at a time inside the room's per-socket rate. It prints p50, p95 and p99. A run from a laptop measures that laptop's distance to the nearest Cloudflare edge: record where it ran. Real browsers report the same timing anonymously (`apps/web/src/net/timings.ts`), by continent, in `GET /api/metrics` (admin).
- **`full-game.mjs`** seats two scripted people beside five bots. Each person files holds and readies every phase, and both vote for a draw from the `--until` year (default 1905). It passes when the game ends `finished` before `--timeout` seconds (default 600). This is also the exit criterion of #8.
- **`e2e-live/metrics.spec.ts`** (in `apps/web`) starts a clock at the front page, presses Play now, chooses a handle and stops when the first movement phase accepts orders, on the desktop and phone projects. It also checks that the page's beacon carries both browser timings and that the server accepts it.

The probes share their preamble (create, join, start, bind a seat) in `lib/probe.mjs` with the server's socket load script (`apps/server/scripts/load-sockets.mjs`), and their nearest-rank percentile in `lib/stats.mjs`.

## Production runs

The probes create real, unlisted games wherever they are pointed, so CI runs them only against the `wrangler dev` the live suite starts (`apps/web/e2e-live/probes.spec.ts`), as a sanity bound. The production lines are run by a maintainer after `pnpm deploy:all`, and committed with the table:

```sh
node tools/metrics/datc.mjs --record "local (cargo)"
node tools/metrics/full-game.mjs https://playcabal.pages.dev --record production
node tools/metrics/order-rtt.mjs https://playcabal.pages.dev --n 100 --record "production, from <city>"
METRICS_RECORD=production LIVE_ORIGIN=https://playcabal.pages.dev pnpm --filter @cabal/web test:e2e:live e2e-live/metrics.spec.ts
```

Then copy the table from `metrics.md` into docs/PLAN.md section 8.

## Tests

`pnpm --filter @cabal/metrics test` (part of `pnpm test`) covers the percentile maths, the report writer and the DATC verdict with `node --test`.

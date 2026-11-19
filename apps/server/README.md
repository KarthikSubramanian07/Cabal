# Cabal server

One Worker, two Durable Object classes, one D1 database and one Queue.

- **`GameRoom`** (one per game) owns the seats, orders, press, pledges, votes, the phase clock, the replay and every WebSocket of its game. It adjudicates with the Rust engine compiled to WebAssembly, in process.
- **D1 `cabal`** (binding `DB`) is the cross-game index: finished and abandoned games, the live listing of public games, guest players and their device sessions, ratings, reliability and the trust ledger. Nothing calls it directly: rooms and the router go through the `GameIndex` and `PlayerStore` ports (`src/game-index.ts`), implemented by `src/d1-index.ts`. Player routes are in `src/players.ts`; the rating maths, the rules of a rated game and the reliability and trust formulas are pure functions in `src/ratings.ts`.
- **`Registry`** (a single instance, `idFromName("global")`) keeps the deployment-wide Claude budget, which needs one serial step per admission. It also holds the games index from before D1, copied into D1 once in the background, and serves that index where no D1 database is bound.
- **`cabal-agent-turns`** carries Claude turns for games that opt into Claude seats. The built-in bot never uses it.

## Lifecycle rules

| Rule | Behaviour |
|---|---|
| Ready-advance | A phase resolves early only when every seat that can act is ready, AI seats included, and at least one present human is playing. |
| AI seats | Every AI seat is played through a `SeatBrain` (`src/brain.ts`). The built-in bot (the Rust heuristic player compiled into `@cabal/engine`, wrapped in `src/bot.ts`) puts orders on file the moment a phase opens. With `aiBrain: "claude"` and a key configured, Claude seats then negotiate (60 seconds), listen (up to two minutes, or until the humans are ready) and order (90 seconds); when any limit passes, or anything fails, the orders on file stand. Their diary and relationships are kept in the room between turns. |
| No humans | A game nobody human is playing is driven by its deadline alone. It is finished when no human power survives, and abandoned after three movement phases with no human order. |
| Deadlines | `live` 10 and 5 minutes, `daily` 24 and 12 hours, `async` 48 and 24 hours (movement, then retreat and adjustment). Explicit seconds override the preset. |
| Grace | When the deadline arrives and a present player still owes orders, the phase waits `graceSeconds` longer, once. |
| Extend | Two present players (or the only one) may add `extendSeconds` to the deadline, once per phase. |
| Pause | Only `live` games pause when every human disconnects. The pause keeps the time that was left, ends by itself after ten minutes per phase, and resumes with that time. `daily` and `async` games never look at connections. |
| No moves received | A movement phase with no order from a player is a miss. Sealed default orders are honoured, and still count as a miss. |
| Civil disorder | Two misses. The seat stays its player's: the bot covers it (when `aiFill` is on) and the player takes it back by submitting orders. |
| Substitutes | After four misses a seated, present player may issue a one-time invite for that seat. The invitee gets a fresh token, the old token dies and its sockets are closed. A caller who already holds a seat is refused. |
| Draws | Every surviving, present human must vote yes in the same phase. AI seats, seats in civil disorder and eliminated players never veto. Without DIAS the voters must also name the same set of sharers. Votes are public and cleared each phase. |
| Adjudication | One storage transaction per phase. A failure rolls everything back, retries after 5, 15 and 45 seconds, then resolves the phase with every unit holding. |
| Spectators | Read-only. A socket is a spectator until it sends `hello { token }`; seat tokens never appear in a URL. |

## Cloudflare resources

Everything is declared in `wrangler.jsonc` for the owner's account. Durable Object classes are created by the `migrations` tags. The D1 schema is the numbered files in `migrations/`: apply them with `pnpm --filter @cabal/server db:migrate` (remote, before deploying a build that needs them) or `db:migrate:local` (done for you by `pnpm dev`); the test suite applies them to its own local database. The Registry applies files 1 to 5 to itself and no further. Never edit a migration that has shipped.

| Binding | Kind | Notes |
|---|---|---|
| `GAME_ROOM` | Durable Object, SQLite | migration tag `v1` |
| `DB` | D1 | database `cabal`, migrations in `migrations/` |
| `REGISTRY` | Durable Object, SQLite | migration tag `v2` |
| `AGENT_QUEUE` | Queue producer and consumer | `cabal-agent-turns`, dead-letter queue `cabal-agent-turns-dlq` |
| `CREATE_LIMITER`, `JOIN_LIMITER`, `READ_LIMITER`, `ACCOUNT_LIMITER` | Rate limit | per client address |
| `PROFILE_LIMITER` | Rate limit | per player |
| `PRESS_LIMITER` | Rate limit | per game and seat |
| `CF_VERSION_METADATA` | Worker version metadata | the build id `/health` reports when `BUILD_ID` is not set |

Secrets and variables:

- `BUILD_ID` (optional). Names the deployed build in `/health` and in error logs, for example `wrangler deploy --var BUILD_ID:$(git rev-parse --short HEAD)`. Without it the Worker version id is used.
- `ANTHROPIC_API_KEY` (secret, optional). Without it every AI seat is played by the built-in bot, whatever a game asks for.
- `CLAUDE_TURNS_PER_GAME` (optional, default 400). The hard cap on Claude turns (one seat, one phase) one game may take; the bot plays every turn after it.
- `CLAUDE_USD_PER_GAME` (optional, default 5). The hard cap on what one game may spend on Claude. The worst-case price of a call is reserved before it is made and the real price settled from the usage the API reports, so the cap cannot be overdrawn; a call that never reports back is charged its whole reservation. `0` turns Claude seats off. A prompt is bounded in UTF-8 bytes (a token is never shorter than a byte), so the reservation covers the bill in any script.
- `CLAUDE_USD_PER_DAY` (optional, default 20) and `CLAUDE_ACTIVE_GAMES` (optional, default 4). The deployment-wide Claude budget, kept by the Registry because only it can see every room. A game is admitted to Claude before it starts, for the whole of its per-game cap, only while the day's commitments and the number of Claude games in play allow it; when it ends it hands back what it did not spend. A game that is refused, or that cannot reach the Registry, is played by the bot. `Registry.claudeBudget(now)` reports where the day stands.

Check a change to the config with `pnpm --filter @cabal/server exec wrangler deploy --dry-run`. Deploys are manual (`pnpm deploy:server`).

## API, health and logs

The wire protocol and every HTTP route are specified in [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md), and a test in `@cabal/protocol` fails when that page and the schemas disagree. Clients should use `CabalSocket` and `createApi` from `@cabal/protocol/client`.

- `GET /health` answers `{ ok, protocol, engine, build, registry: { reachable, schema }, index: { backend, reachable, schema }, time }`. It stays 200 when either store is down and says so. It is rate limited like any read, and asks the stores at most once every five seconds per isolate.
- Every log line is one JSON object with an `event` field (`game_created`, `phase_adjudicated`, `agent_call`, `registry_handoff`, ...). Room events carry `gameId` and `phase`.
- An exception anywhere in a request is caught in `src/index.ts`, logged as `unhandled_error` with a `requestId`, the route and the build, and answered with a JSON 500 that carries the same `requestId` and CORS headers.
- Orders are judged against the board in one place, `src/validate.ts`, by the engine's own validator (`game.validateOrders`). `orders.ack` reports a verdict per order, with the engine's finer reason as `detail`, and only legal orders are put on file. Pledges are checked with `game.pledgeCheck` and their receipts judged with `game.pledgeReceipt`.

## Tests

`pnpm --filter @cabal/server test` runs inside workerd against the real Worker, Durable Objects, alarms and queue. `test/lifecycle.test.ts` and `test/security.test.ts` are the regression suites for the lifecycle and security reviews of this server; `test/agents.test.ts` covers Claude seats with a scripted model, so no test calls the API. `test/wire.test.ts` and `test/http.test.ts` pin the contract a client is built against (numbered frames and resume, the welcome, press history, seals, votes, verdicts, listings, health). `test/fullgame.test.ts` plays a whole game through `@cabal/protocol/client`: two players on real WebSockets and five bot seats, from the lobby through an adjustment phase to an agreed draw, with one player dropping and resuming on the way. `test/players.test.ts`, `test/standing.test.ts`, `test/d1-index.test.ts` and `test/ratings.test.ts` cover guest identity, seats bound to players, rating finished games, the leaderboard and the trust ledger, the D1 adapter and the copy from the Registry, and the rating maths (Glickman's worked example included). `test/hardening.test.ts` and `test/budget.test.ts` are the regression suites for the adversarial reviews (retreats, socket admission, storage bounds, the public list, draws, the Claude budget). Most suites play AI seats with `test/peaceful-bot.ts`, which never dislodges anything, so a test meets no retreat it did not arrange; `test/fullgame.test.ts` and `test/bot.test.ts` use the real bot, and the second plays years of real fighting to check that every phase, retreats included, resolves.

## Socket load probe

After deploying, run `pnpm --filter @cabal/server load:sockets -- https://<worker-host> 200`. The script opens the requested sockets, sends one public press message, and reports broadcast p50, p95 and maximum latency. It accepts up to 201 total sockets: the creator plus the room's 200 unbound sockets (a 201st spectator would make the oldest one give way). The latency includes the client's own round trip.

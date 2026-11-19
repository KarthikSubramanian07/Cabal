# Cabal server

One Worker, two Durable Object classes and one Queue.

- **`GameRoom`** (one per game) owns the seats, orders, press, pledges, votes, the phase clock, the replay and every WebSocket of its game. It adjudicates with the Rust engine compiled to WebAssembly, in process.
- **`Registry`** (a single instance, `idFromName("global")`) is the global index of finished and abandoned games. Rooms hand their final summary to it over RPC.
- **`cabal-agent-turns`** carries Claude turns for games that opt into Claude seats. The built-in bot never uses it.

## Lifecycle rules

| Rule | Behaviour |
|---|---|
| Ready-advance | A phase resolves early only when every seat that can act is ready, AI seats included, and at least one present human is playing. |
| AI seats | The built-in bot puts orders on file the moment a phase opens. With `aiBrain: "claude"` and a key configured, Claude is then asked for better ones; the room waits at most 90 seconds, then the bot's orders stand. |
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

Everything is declared in `wrangler.jsonc` for the owner's account. Nothing needs a manual migration step: Durable Object classes are created by the `migrations` tags, and the Registry's SQL schema is applied by the object itself (`src/registry.ts`, numbered migrations).

| Binding | Kind | Notes |
|---|---|---|
| `GAME_ROOM` | Durable Object, SQLite | migration tag `v1` |
| `REGISTRY` | Durable Object, SQLite | migration tag `v2` |
| `AGENT_QUEUE` | Queue producer and consumer | `cabal-agent-turns`, dead-letter queue `cabal-agent-turns-dlq` |
| `CREATE_LIMITER`, `JOIN_LIMITER`, `READ_LIMITER` | Rate limit | per client address |
| `PRESS_LIMITER` | Rate limit | per game and seat |

Secrets and variables:

- `ANTHROPIC_API_KEY` (secret, optional). Without it every AI seat is played by the built-in bot, whatever a game asks for.
- `CLAUDE_TURNS_PER_GAME` (optional, default 400). The hard cap on Claude requests one game may make; the bot plays every turn after it.

Check a change to the config with `pnpm --filter @cabal/server exec wrangler deploy --dry-run`. Deploys are manual (`pnpm deploy:server`).

## Tests

`pnpm --filter @cabal/server test` runs inside workerd against the real Worker, Durable Objects, alarms and queue. `test/lifecycle.test.ts` and `test/security.test.ts` are the regression suites for the lifecycle and security reviews of this server; `test/agents.test.ts` covers Claude seats with a scripted model, so no test calls the API.

## Socket load probe

After deploying, run `pnpm --filter @cabal/server load:sockets -- https://<worker-host> 200`. The script opens the requested sockets, sends one public press message, and reports broadcast p50, p95 and maximum latency. It accepts up to 201 total sockets: the creator plus the room's 200 spectator limit. The latency includes the client's own round trip.

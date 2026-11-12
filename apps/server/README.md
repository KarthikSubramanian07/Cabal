# Cabal server

`GameRoom` owns each game's seats, orders, press, phase clock, replay and WebSockets. It pauses while all active human seats are disconnected, resumes on a human reconnect, and marks a game abandoned after three resolved phases with no orders.

## Cloudflare bindings

The Worker config declares create, join and press rate limits, a D1 game index, and the `cabal-agent-turns` Queue. Before deploying to a Cloudflare account:

1. Create the D1 database with `npx wrangler d1 create cabal-cross-game`, put its returned ID in `wrangler.jsonc`, and apply `migrations/` with `npx wrangler d1 migrations apply cabal-cross-game --remote`.
2. Create the Queue with `npx wrangler queues create cabal-agent-turns`.
3. Set `ANTHROPIC_API_KEY` as a Worker secret to enable Claude-controlled agents. Without it, agents choose from legal orders using the local fallback brain.
4. Deploy with `pnpm deploy:server`.

Each created game stores the request origin for its Queue agent client, so no account-specific `SERVER_URL` is needed. D1 and Queue bindings are optional in local tests; without D1, game summaries remain in the Durable Object outbox for retry when the binding is configured.

## Socket load probe

After deploying, run `pnpm --filter @cabal/server load:sockets -- https://<worker-host> 200`. The script opens the requested sockets, sends one public press message, and reports broadcast p50, p95 and maximum latency. It accepts up to 201 total sockets: the authenticated creator plus the room's 200 spectator limit.

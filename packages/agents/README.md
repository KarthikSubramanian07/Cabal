# @cabal/agents

AI players for Cabal. A `Player` turns a board into a prompt, asks a `Brain` for a decision, and
checks every order against the engine's legal menu before it is sent, so an AI seat never submits
an illegal order. Brains are interchangeable:

| Brain | What it is | Cost |
|---|---|---|
| `BotBrain` | the Rust heuristic bot (`crates/cabal-bot`) reading the structured board | free, a few ms |
| `ClaudeBrain` | Claude with structured output, prompt caching and effort per phase kind | metered |
| `CappedBrain` | any metered brain under one or more hard `SpendCap`s | never past its caps |
| `FailoverBrain` | asks one brain, plays another's orders when the first fails or is capped | |

`AgentClient` plays a `Player` against a real `cabal-server` over the same WebSocket protocol a
person uses.

## The arena

```sh
pnpm arena                         # one game, seven bot seats, in process, to the end of 1910
pnpm arena --games 10 --check      # exit 1 if any game fails the gates
pnpm arena --wrangler              # start wrangler dev and play through the real server
pnpm arena --server http://localhost:8787
pnpm arena --help
```

Every seat is the free bot unless Claude seats are asked for. Claude is opt-in per power and
refuses to start without `ANTHROPIC_API_KEY` and a hard budget for the whole run:

```sh
ANTHROPIC_API_KEY=... pnpm arena --claude FRANCE,ITALY --budget 2 --games 1
```

Each Claude seat is capped by its share of the budget and by the budget itself. Before each call
the worst case it could cost is reserved against both, so seven seats in parallel cannot overdraw
it; when a cap cannot cover the next call, the seat plays the bot's orders instead.

A run writes, under `--out` (default `arena-out`):

- `games/<id>.json`: the MILA saved game, with press, pledges and receipts;
- `decisions/<id>.jsonl`: one record per decision (prompt, decision, dropped orders, tokens, cost);
- `summary.json` and `summary.md`: per game, off-menu and illegal orders, hold rate, pledges made,
  kept and broken, honesty, supply centres at the end of each year per power, cost, and whether the
  saved game replays exactly.

The nightly `Stress` workflow plays ten games in process and one through `wrangler dev` with bot
seats only (no secrets, no spend) and publishes the report as an artifact.

## Prompt

- A unit with more than twelve legal orders is framed as candidates: where its moves lead, then
  its orders grouped as moves, supports for its own side, supports for others, and convoys.
- The first movement decision of a year writes a plan for the year, shown for the rest of it.
- Once a year the diary is folded: last year in the model's words, older years mechanically.
- The system prompt carries the rules digest, the map and the pledge strategy, and is cached.

# Protocol

All real time traffic runs over one WebSocket per client to the game's Durable Object. Messages are JSON envelopes validated with zod schemas from `@cabal/protocol`. HTTP is used only for lobby, identity and read-only game data.

## Order notation

Cabal uses the notation shared by the MILA engine, Cicero and the AI Diplomacy harness so that saved games and research tooling interoperate.

```
A PAR - BUR              move
A CON H                  hold
A PAR S A BUR - PIC      support a move
A WAL S F LON            support a hold
A LON - BRE VIA          move by convoy
F NTH C A LON - BRE      convoy
F LYO - SPA/SC           move to a specific coast
F BLA R SEV              retreat
A BUL D                  disband (retreat or adjustment phase)
A PAR B                  build
WAIVE                    waive a build
```

Province codes are three letters. Coasts are `/NC`, `/SC`, `/EC`, `/WC`. Parsing is case-insensitive and tolerant of `-`, `->`, `S`, `SUPPORTS`, `C`, `CONVOYS`, `VIA`, `VIA CONVOY`.

## Phase names

`S1901M` Spring 1901 Movement, `S1901R` Spring 1901 Retreat, `F1901M`, `F1901R`, `W1901A` Winter 1901 Adjustment, `COMPLETED`.

## Envelope

```json
{ "t": "<type>", "id": "<client message id, optional>", "seq": 42, "p": { ... } }
```

`PROTOCOL_VERSION` is 2. The schemas in `packages/protocol/src/index.ts` are the contract; this page describes them, and a test fails when the two disagree.

- `id` is chosen by the client. `welcome` (after `hello`), `orders.ack`, `orders.default.ack`, `press`, `extend.ack`, `synced` and `error` echo the `id` of the frame they answer.
- `seq` is set by the server on every **broadcast** frame: anything that changes what the table knows and that `sync` can replay. It is that frame's own number in the room's sequence, which only ever grows. Replies to one socket (`welcome`, `orders.ack`, `orders.default.ack`, `extend.ack`, `press.unread`, `synced`, `error`) and presence-only `seats` frames carry no `seq`.
- Frames are JSON text of at most 4 KB. Every frame spends the socket's rate limit (burst 30, 10 per second; `sync` costs five).
- Keepalive: the client sends the text `ping` and the server answers the text `pong` without waking the room. Neither is a JSON frame.

## Connecting

Open `GET /api/games/:id/ws`. The socket is a spectator at once and receives a `welcome` with `power: null`. A player then sends `hello { token }` as the first frame, which binds the socket to the seat and is answered with that seat's `welcome`. Seat tokens never appear in a URL: a `?token=` query is refused with 400. A bad token gets `error bad_token` and close code 4401. When a seat changes hands its open sockets are closed with code 4001. A ninth socket for one seat is closed with 4429. A client should not reconnect after 4001, 4401 or 4429.

Spectators are read-only: every frame except `hello` and `sync` is answered `error spectator`.

### Reconnecting and resuming

A client remembers the highest `seq` it has applied. After a reconnect it sends `hello` again and gets a `welcome`, whose `seq` is the number of the last broadcast frame the snapshot already contains. If that is higher than the client's own cursor it sends `sync { since: <its cursor> }`. The server replays, in order and each with its `seq`, the stored frames after `since` that this viewer may see, at most 500 per request, then `synced { seq, more, gap }`. While `more` is true the client sends `sync { since: seq }` again.

- A frame is never replayed to a cursor at or past its own number: `sync { since: n }` starts at `n + 1`.
- `gap: true` means the frames after `since` are no longer stored (a room keeps the last 4,000) or the cursor is ahead of the room. Nothing is replayed; the `welcome` is the truth.
- A replayed `press` frame shows its pledge as it stands for the viewer now (their own sealed orders, or the receipt that has since arrived).
- Apply replayed frames before the `welcome`, then live frames after it, dropping any frame whose `seq` is at or below the cursor. `CabalSocket` in `@cabal/protocol/client` does all of this, plus backoff and the keepalive.

## Client to server

| type | payload | notes |
|---|---|---|
| `hello` | `{ token }` | binds the socket to a seat; answered with `welcome` |
| `orders.set` | `{ phase, orders }` | replaces the seat's orders for the phase; answered with `orders.ack`. From a seat in civil disorder, at least one accepted order takes the seat back |
| `orders.default` | `{ orders }` | sealed movement orders used if the seat misses a deadline (the phase still counts as missed); answered with `orders.default.ack` |
| `ready` | `{ phase, ready }` | the phase resolves when every seat that can act is ready |
| `extend` | `{ phase }` | asks for more time; granted once per phase when two present players (or the only one) ask |
| `press.send` | `{ to, body, pledge? }` | `to` is a power or `ALL`; `pledge` is `{ orders, sealed, nonce?, commitment? }`. In the lobby only `to: "ALL"` without a pledge |
| `press.read` | `{ with, upTo }` | marks the thread with a power (or `ALL`) read up to a message's `sentAt`; answered with `press.unread`. Allowed in every game status |
| `vote` | `{ kind, value, include? }` | `kind` is `"draw"`; `include` names the sharers of a non-DIAS draw, absent means every survivor |
| `sync` | `{ since }` | replays up to 500 stored frames after `since`, then `synced` |

## Server to client

| type | payload | notes |
|---|---|---|
| `welcome` | `{ protocol, gameId, settings, status, pauseReason, pausedUntil, pausedRemainingMs, power, host, phase, state, seats, deadlineAt, serverTime, seq, orders, defaults, press, pressMore, unread, votes, history, finished }` | the full snapshot, see below |
| `state` | `{ phase, state, deadlineAt, serverTime, seq, status }` | when the game starts, after every adjudication and at the end of the game |
| `results` | `{ phase, results, dislodged, standoffs, civil_disorder, summary, seq }` | per-order outcomes with reasons; `summary` is the entry this phase adds to `history` |
| `orders.ack` | `{ phase, accepted, rejected, verdicts }` | `accepted` is what is now on file; `verdicts` has one `{ text, order, ok, code, reason }` per order sent |
| `orders.default.ack` | `{ accepted, rejected }` | the sealed defaults now on file |
| `press` | `{ id, phase, from, to, body, sentAt, pledge }` | `phase` is `LOBBY` for table talk before the start; `sentAt` is strictly increasing within a game |
| `press.unread` | `{ unread }` | the seat's unread counts per thread after a `press.read`, to every socket of the seat |
| `pledge.receipt` | `{ pledgeId, receipt, revealed, nonce }` | `receipt` is `kept`, `broken` or `void`; to the pledge's audience and its pledger, after adjudication |
| `seats` | `{ seats }` | join, start, orders in, ready, civil disorder, recovery, substitution, and (without `seq`) a player connecting or leaving |
| `deadline` | `{ phase, deadlineAt, serverTime, grace? }` | `grace: true` marks the one-off grace period; `deadlineAt` is null while paused |
| `extend` | `{ phase, requestedBy, needed, granted, deadlineAt }` | to everyone on each request, so a second player can see one is pending |
| `extend.ack` | `{ phase, requests, extended }` | to the requester |
| `votes` | `{ phase, draw, required, hidden, cast, yes }` | on every vote, and emptied when the phase resolves |
| `status` | `{ status, reason, until? }` | lifecycle changes: `active`, `paused` (with the time the pause ends by itself), `finished`, `abandoned` |
| `finished` | `{ result, winners, scores, reason }` | `result` is `solo`, `draw` or `abandoned` |
| `synced` | `{ seq, more, gap }` | ends a `sync` reply |
| `error` | `{ code, message }` | see below |

Error codes: `rate_limited`, `too_large` (the socket is then closed with 1009), `bad_json`, `bad_frame`, `bad_token`, `too_many_sockets`, `spectator`, `not_active`, `seat_inactive`, `stale_phase`, `bad_order`, `no_press`, `public_only`, `lobby_public_only`, `press_closed`, `press_limit`, `whisper_budget`, `press_rate_limited`, `bad_pledge`, `bad_vote`, `extension_used`, `adjudication_retry`, `adjudication_fallback`.

### The welcome

A `welcome` is everything a client needs to draw the game from nothing:

| field | meaning |
|---|---|
| `protocol` | the server's `PROTOCOL_VERSION` |
| `gameId`, `settings`, `status` | the game, its resolved settings (see Settings) and its status |
| `pauseReason`, `pausedUntil`, `pausedRemainingMs` | set while a live game is paused |
| `power` | the viewer's seat, null for a spectator |
| `host` | the seat that created the game and may start it |
| `phase`, `state` | the current phase and the board in MILA layout |
| `seats` | every seat, see Seats |
| `deadlineAt`, `serverTime` | the phase deadline and the server's clock when the frame was built; count down against `serverTime`, never the local clock alone |
| `seq` | the number of the last broadcast frame this snapshot contains: the `sync` cursor |
| `orders`, `defaults` | the viewer's own orders on file for the phase and their sealed defaults. Nobody else's orders are ever sent before adjudication |
| `press`, `pressMore` | the most recent 500 messages the viewer may read, oldest first, and whether older ones exist (`GET /api/games/:id/press`) |
| `unread` | unread messages per thread (`ALL` or the other power) |
| `votes` | the draw vote, see Draws |
| `history` | every resolved phase, oldest first: `{ phase, adjudicatedAt, centers }` with supply-centre counts per power |
| `finished` | null, or `{ result, winners, scores, reason }` once the game is over |

## Settings

`POST /api/games` takes any subset; the rest are filled in. Clock fields left out come from the pacing preset (live 10 and 5 minutes, daily 24 and 12 hours, async 48 and 24 hours).

| setting | values | default | meaning |
|---|---|---|---|
| `variant` | `standard` | `standard` | the map |
| `rulebook` | `2023`, `1982`, `1971`, `dptg` | `2023` | the rules edition the engine applies |
| `press` | `full`, `public`, `gunboat` | `full` | private and public press, public only, or none |
| `pacing` | `live`, `daily`, `async` | `async` | the clock preset; only live games pause on absence |
| `movementSeconds` | 60 to 1,209,600 | preset | movement phase length |
| `shortPhaseSeconds` | 30 to 604,800 | preset | retreat and adjustment phase length |
| `graceSeconds` | 0 to 3,600 | preset | one-off wait at the deadline when a present player still owes orders |
| `extendSeconds` | 30 to 86,400 | preset | what a granted extension adds |
| `whisperBudget` | 0 to 60, or null | null | private messages one power may send per phase; null is unlimited |
| `rulebookPress` | boolean | false | no press during retreat and adjustment phases |
| `readyAdvance` | boolean | true | resolve as soon as every seat that can act is ready |
| `dias` | boolean | true | Draws Include All Survivors; false lets voters name a subset |
| `ghostVotes` | boolean | true | eliminated players may cast an advisory draw vote |
| `cabals` | boolean | false | reserved for the Cabal layer |
| `aiFill` | boolean | true | open seats become AI seats at the start; the bot covers seats in civil disorder |
| `aiBrain` | `bot`, `claude` | `bot` | who plays AI seats |
| `scoring` | `sos`, `dss` | `sos` | how a draw is shared: Sum of Squares, or Draw Size (equal shares) |
| `visibility` | `public`, `unlisted` | `unlisted` | public games are listed by `GET /api/games` while open or running |
| `publicVotes` | boolean | true | whether a draw vote shows who cast it |

## Game status

`lobby`, `active`, `paused`, `finished`, `abandoned`.

- `lobby`: seats are being claimed. Seated players may send press to `ALL` (table talk, stored with `phase: "LOBBY"`); nothing else is accepted. The game starts when the seventh seat is claimed or the host calls `start`.
- `paused` happens only in `live` pacing, when every human player has disconnected. The phase clock stops with its remaining time banked, the pause ends by itself (at most ten minutes of pause per phase) and the game resumes with exactly that time. Daily and async games never pause.
- `finished` carries a result of `solo` or `draw` and a reason: `solo`, `vote`, `engine_draw`, or `no_humans_left` (no human power survives on the board).
- `abandoned` carries a reason: `no_orders` (three movement phases without a human order), `lobby_expired` (a lobby not started within a week) or `adjudication_failed`.

## Seats

Each entry of `seats` is `{ power, kind, name, ready, eliminated, missed, autopilot, brain, present, submitted, canAct, host }`.

| kind | meaning |
|---|---|
| `open` | unclaimed, in the lobby |
| `human` | a player's seat |
| `ai` | played by the built-in bot, or by Claude when the game sets `aiBrain: "claude"` and the server has a key |
| `civil_disorder` | its player has missed two movement phases; `autopilot: true` means the bot is covering it |

| flag | meaning |
|---|---|
| `ready` | the seat has declared itself done for the phase |
| `eliminated` | no units and no centres |
| `missed` | consecutive movement phases without orders from the player |
| `autopilot` | the bot is covering this civil-disorder seat until its player returns |
| `brain` | `bot` or `claude` for an AI seat or a seat on autopilot; null for a seat a person plays |
| `present` | a connection is bound to the seat (always true for an AI seat) |
| `submitted` | orders are on file for the current phase. The orders themselves are never sent to anyone else before adjudication |
| `canAct` | the seat has something to order this phase |
| `host` | the seat that created the game |

### AI seats

Every AI seat is played every phase. The moment a phase opens the built-in bot's orders are on file for each AI seat and each seat on autopilot, so an AI seat can never leave a phase without orders or hold one up.

A game that sets `aiBrain: "claude"` on a server that holds an API key then asks Claude for better orders. Claude seats use no part of this protocol and hold no token: their turns travel through an internal queue as `{ gameId, power, phase, step }` and reach the room over its private binding, which the internet cannot address. What they send is ordinary press and ordinary orders, subject to the same rules as a player's.

A movement phase is played in two steps, both visible to the table as `seats` frames (`ready` stays false for a Claude seat until its orders are in):

1. **Negotiate.** Each seat reads the press so far and sends up to three messages and at most one pledge. Talks close after 60 seconds.
2. **Listen.** The room waits for the table to answer: a quarter of the phase, two minutes at most, or until every human who can act is ready.
3. **Order.** Each seat reads everything said in the phase, then submits orders. Orders are due 90 seconds later.

Retreat and adjustment phases, gunboat games and movement phases shorter than four minutes skip straight to step 3. Every limit is also capped by the phase deadline. When a limit passes, a call fails, the queue is down or the budget is spent, nothing has to happen: the orders already on file are adjudicated.

Spend is capped per game (5 US dollars unless the server says otherwise). The worst-case price of each call is reserved before it is made and the real price settled from the API's usage report, so the cap holds whatever the calls cost. `GET /api/games/:id` reports it as `ai: { brain, model, claudeTurns, claudeCalls, spentUsd, capUsd, tokens, stopped }`; `stopped` is null, or why the game went back to the bot (`spend_cap`, `model_failing`, `model_unauthorised`).

A seat in civil disorder still belongs to its player, whose token keeps working: submitting orders takes it back. After four missed movement phases the seat is vacant, and a seated player may open it to a substitute (see HTTP).

## Orders

`orders.set` replaces the seat's whole order list for the phase. Every order is judged against the board before it is put on file, and `orders.ack.verdicts` reports each one in the order sent:

| verdict code | meaning |
|---|---|
| `ok` | legal; on file in canonical text (`order`) |
| `syntax` | the text is not an order |
| `foreign_power` | the order names another power |
| `no_such_unit` | the seat has no such unit (or, in a retreat phase, no such dislodged unit) |
| `illegal` | the unit exists but cannot be given that order on this board |
| `superseded` | a later order in the same list was for the same unit (or the same build province); the last one stands |
| `over_allowance` | more builds or disbands than the seat is due; the first ones stand |

`accepted` lists what is on file and `rejected` repeats the refused orders as `{ text, reason }`. Sealed defaults (`orders.default`) are checked for syntax and ownership only, because the board they will be used on is not known yet.

## Press

Messages go to one power or to `ALL`. A seat reads public messages and the private ones it sent or received; a spectator reads public ones. `welcome.press` holds the latest 500; older ones are paged over HTTP. Read markers are kept per seat and thread: `press.read { with, upTo }` moves a marker forward, and `welcome.unread` and `press.unread` count what others have sent since.

## Draws

A draw passes when every surviving, present human player has voted yes in the current phase. Seats played by AI, seats in civil disorder and eliminated players are never required, so nobody absent can veto. With `dias: true` the draw is shared by all survivors. With `dias: false` every required voter must also name the same `include` set, and only the powers in it share the result: it still takes everyone to agree. Votes are cleared when the phase resolves. With `ghostVotes: true` an eliminated player may cast a vote that counts for nothing.

`votes` is `{ phase, draw, required, hidden, cast, yes }`. `required` lists the seats whose agreement is needed; `cast` and `yes` count how many of them have voted and voted yes, and are always public. With `publicVotes: true` (the default) `draw` lists every ballot as `{ power, value, include }`. With `publicVotes: false`, `hidden` is true and `draw` holds only the viewer's own ballot: the table sees the tally, never who cast it. A voter is then sent a `votes` frame of their own after the one everybody gets.

A draw is scored by the game's `scoring`: `sos` gives each sharer its centre count squared over the sum of squares, `dss` gives each sharer an equal part. A solo is always 1 to the winner.

## Pledges

1. Sender chooses orders to commit to. Open pledge: the recipient sees the orders. Sealed pledge: recipients see only `commitment = blake3(canonical(orders) || nonce)` until adjudication.
2. The client may pick the 16 byte hex `nonce` and send the `commitment` it computed with `pledgeCommit(orders, nonce)` over the canonical order text; the server then refuses the pledge (`bad_pledge`) unless its own commitment is identical. When no nonce is sent the server picks one. Either way the pledger sees `pledge.nonce` at once.
3. The server stores the pledge with the phase it applies to. Every pledged order must be one the pledger's own units can legally be given in that phase; anything else is refused with `bad_pledge` and the message is not sent.
4. After adjudication the server compares the pledged orders to the orders the pledger actually submitted for that phase. Every pledged order present: `kept`. Any missing: `broken`. Nothing submitted, or the phase resolved by the all-hold fallback: `void`.
5. `pledge.receipt { pledgeId, receipt, revealed, nonce }` goes to the pledge audience and its pledger. The nonce is revealed with it, so anyone who holds the commitment can check `pledgeOpens(commitment, revealed, nonce)` for themselves. Until then `pledge.nonce` is null for everybody but the pledger.
6. Receipts are counted in the game's ledger. `GET /api/games/:id/ledger` and the replay list each resolved pledge with its commitment, nonce, orders and receipt: pledges made to `ALL` for anyone, private pledges for the two powers they concern, and every pledge once the game is over.

A seal protects a player from the other players, not from the server, which must see the orders to issue the receipt.

## HTTP

| method and path | purpose |
|---|---|
| `POST /api/games` | create a game from `{ name, settings? }`; returns `{ gameId, token, power }` |
| `GET /api/games` | `status=open` lists public lobbies with a free seat, `status=active` public games in play, `status=finished` (the default) finished and abandoned games. `limit` (up to 100) and `before` page each list; `result` filters the finished one. Answers `{ status, games }` |
| `POST /api/games/:id/join` | `{ name, power? }` claims a lobby seat; `{ name, invite }` takes a vacated seat in a running game. Refused with 409 for a caller who presents a seat token for this game |
| `POST /api/games/:id/start` | the host starts early; open seats become AI seats when `aiFill` is on. Answers the summary |
| `POST /api/games/:id/substitute` | `{ power }` with a seated player's bearer token: returns a one-time `invite` for a seat whose player has missed four movement phases |
| `GET /api/games/:id` | the public summary: `{ id, settings, status, phase, host, deadlineAt, serverTime, createdAt, seats, finished, pauseReason, pausedUntil, pausedRemainingMs, history, ai }` |
| `GET /api/games/:id/replay` | MILA-compatible saved game JSON, with one extra key `cabal`: `{ protocol, status, finished, pledges, history }` |
| `GET /api/games/:id/ledger` | `{ gameId, ledger, entries }`: kept, broken and void counts per power, and the resolved pledges the caller may read as `{ id, pledger, audience, phase, sealed, commitment, nonce, orders, receipt }` |
| `GET /api/games/:id/press` | `{ gameId, press, more }`: one page of press, oldest first. `before=<sentAt>` pages backwards, `with=<power or ALL>` narrows to one thread, `limit` is at most 200 |
| `GET /api/games/:id/ws` | the WebSocket |
| `GET /health` | `{ ok, protocol, engine, build, registry, time }`: the engine's version, the deployed build and whether the games index answers (`registry: { reachable, schema }`) |

Bearer tokens go in the `Authorization` header, never in a URL. `ledger`, `replay` and `press` are public; a seat token widens them to that seat's private pledges and threads. Create, join and substitute are rate limited per client address, as are reads, starts and socket upgrades.

Every answer is JSON with CORS headers. A request that fails inside the server is answered `500 { error: "internal error", requestId }`; the same `requestId` is on the structured log line.

A listing from `GET /api/games?status=open|active` is `{ gameId, status, settings, cluster, hostName, humans, openSeats, phase, deadlineAt, createdAt, updatedAt }`. A finished game is `{ gameId, result, reason, winners, scores, settings, cluster, phaseCount, createdAt, finishedAt, ledger, seats }`.

## Client library

`@cabal/protocol/client` exports `CabalSocket` (hello, resume by `seq`, backoff with jitter, keepalive, requests matched to replies by `id`) and `createApi` (typed calls for every route above). Both take their transport as an argument, so the same code runs in a browser, in Node and inside workerd tests.

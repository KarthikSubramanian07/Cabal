# Protocol

All real time traffic runs over one WebSocket per client to the game's Durable Object. Messages are JSON envelopes validated with zod schemas from `@cabal/protocol`. HTTP is used only for lobby, identity, profiles and read-only game data.

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
- Frames are JSON text of at most 16 KB (16,384 bytes, room for the longest press message in any script). Every frame spends the socket's rate limit (burst 30, 10 per second; `sync` and `hello` cost five). A frame refused as `rate_limited` or `bad_frame` is still answered with the `id` it carried.
- Keepalive: the client sends the text `ping` and the server answers the text `pong` without waking the room. Neither is a JSON frame.

## Connecting

Open `GET /api/games/:id/ws`. The socket is a spectator at once and receives a `welcome` with `power: null`. A player then sends `hello { token }` as the first frame, which binds the socket to the seat and is answered with that seat's `welcome`. Seat tokens never appear in a URL: a `?token=` query is refused with 400. A bad token gets `error bad_token` and close code 4401. When a seat changes hands its open sockets are closed with code 4001. A ninth socket for one seat is closed with 4429. A client should not reconnect after 4001, 4401 or 4429.

A room holds 200 sockets that have not bound to a seat. It never refuses a new connection for that reason, because a player's socket starts unbound too: the oldest unbound socket is sent `error spectator_evicted` and closed with 4408 to make way. A spectator closed with 4408 may reconnect.

Spectators are read-only: every frame except `hello` and `sync` is answered `error spectator`.

### Reconnecting and resuming

A client remembers the highest `seq` it has applied. After a reconnect it sends `hello` again and gets a `welcome`, whose `seq` is the number of the last broadcast frame the snapshot already contains. If that is higher than the client's own cursor it sends `sync { since: <its cursor> }`. The server replays, in order and each with its `seq`, the stored frames after `since` that this viewer may see, at most 500 per request, then `synced { seq, more, gap }`. While `more` is true the client sends `sync { since: seq }` again.

- A frame is never replayed to a cursor at or past its own number: `sync { since: n }` starts at `n + 1`.
- `gap: true` means the frames after `since` are no longer stored (a room keeps the frames numbered within 4,000 of the newest, pruned as they are written) or the cursor is ahead of the room. Nothing is replayed; the `welcome` is the truth.
- `seats` and `votes` frames are whole snapshots, so the room stores only the newest one for each audience. A replay therefore skips the older ones; applying the newest leaves a client exactly where applying all of them would.
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
| `press.send` | `{ to, body, pledge?, quote? }` | `to` is a power or `ALL`; `pledge` is `{ orders, sealed, nonce?, commitment? }`; `quote` is the id of an earlier message in the same thread (refused with `bad_quote` otherwise). In the lobby only `to: "ALL"` without a pledge |
| `press.read` | `{ with, upTo }` | marks the thread with a power (or `ALL`) read up to a message's `sentAt`; answered with `press.unread`. Allowed in every game status |
| `vote` | `{ kind, value, include? }` | `kind` is `"draw"`; `include` names the sharers of a non-DIAS draw, absent means every survivor |
| `sync` | `{ since }` | replays up to 500 stored frames after `since`, then `synced` |

## Server to client

| type | payload | notes |
|---|---|---|
| `welcome` | `{ protocol, gameId, settings, status, pauseReason, pausedUntil, pausedRemainingMs, power, host, phase, state, seats, deadlineAt, serverTime, seq, orders, defaults, press, pressMore, unread, votes, history, finished }` | the full snapshot, see below |
| `state` | `{ phase, state, deadlineAt, serverTime, seq, status }` | when the game starts, after every adjudication and at the end of the game |
| `results` | `{ phase, results, dislodged, standoffs, civil_disorder, rejected?, summary, seq }` | per-order outcomes, see Results; `rejected` lists orders the engine could not adjudicate at all; `summary` is the entry this phase adds to `history` |
| `orders.ack` | `{ phase, accepted, rejected, verdicts }` | `accepted` is what is now on file; `verdicts` has one `{ text, order, ok, code, reason, detail? }` per order sent |
| `orders.default.ack` | `{ accepted, rejected }` | the sealed defaults now on file |
| `press` | `{ id, phase, from, to, body, sentAt, pledge, quote }` | `phase` is `LOBBY` for table talk before the start; `sentAt` is strictly increasing within a game; `quote` is null or `{ id, from, phase, excerpt }`, the quoted message as the server holds it (its first 280 characters) |
| `press.unread` | `{ unread }` | the seat's unread counts per thread after a `press.read`, to every socket of the seat |
| `pledge.receipt` | `{ pledgeId, receipt, revealed, nonce }` | `receipt` is `kept`, `broken` or `void`; to the pledge's audience and its pledger, after adjudication |
| `seats` | `{ seats }` | join, start, orders in, ready, civil disorder, recovery, substitution, and (without `seq`) a player connecting or leaving |
| `deadline` | `{ phase, deadlineAt, serverTime, grace? }` | `grace: true` marks the one-off grace period; `deadlineAt` is null while paused |
| `extend` | `{ phase, requestedBy, needed, granted, deadlineAt }` | to everyone when a player first asks and when the extension is granted, so a second player can see one is pending. Asking again changes nothing and is not announced |
| `extend.ack` | `{ phase, requests, extended }` | to the requester |
| `votes` | `{ phase, draw, required, hidden, cast, yes }` | on every vote, and emptied when the phase resolves |
| `status` | `{ status, reason, until? }` | lifecycle changes: `active`, `paused` (with the time the pause ends by itself), `finished`, `abandoned` |
| `finished` | `{ result, winners, scores, reason }` | `result` is `solo`, `draw` or `abandoned` |
| `synced` | `{ seq, more, gap }` | ends a `sync` reply |
| `error` | `{ code, message }` | see below |

Error codes: `rate_limited`, `too_large` (the socket is then closed with 1009), `bad_json`, `bad_frame`, `bad_token`, `too_many_sockets`, `spectator`, `spectator_evicted` (the socket is then closed with 4408), `not_active`, `seat_inactive`, `stale_phase`, `bad_order`, `no_press`, `public_only`, `lobby_public_only`, `press_closed`, `press_limit`, `whisper_budget`, `bad_quote` (a quote from another thread, or of a message that does not exist), `press_rate_limited`, `bad_pledge`, `bad_vote`, `too_many_changes` (a seat may change its ready flag or its ballot 40 times in one phase), `extension_used`, `adjudication_retry`, `adjudication_fallback`, `internal`.

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

Each entry of `seats` is `{ power, kind, name, handle?, ready, eliminated, missed, autopilot, brain, present, submitted, canAct, host }`.

| kind | meaning |
|---|---|
| `open` | unclaimed, in the lobby |
| `human` | a player's seat |
| `ai` | played by the built-in bot (the heuristic player compiled into the engine, see `docs/BOT.md`), or by Claude when the game sets `aiBrain: "claude"` and the server has a key |
| `civil_disorder` | its player has missed two movement phases; `autopilot: true` means the game's AI is covering it (the bot, or Claude in a Claude game) |

| flag | meaning |
|---|---|
| `handle` | the holder's handle when they are signed in (their profile is `GET /api/players/:handle`); null for anonymous play and AI |
| `ready` | the seat has declared itself done for the phase |
| `eliminated` | no units and no centres |
| `missed` | consecutive movement phases without orders from the player |
| `autopilot` | the game's AI is covering this civil-disorder seat until its player returns; `brain` says which |
| `brain` | `bot` or `claude` for an AI seat or a seat on autopilot; null for a seat a person plays |
| `present` | a connection is bound to the seat (always true for an AI seat) |
| `submitted` | orders are on file for the current phase. The orders themselves are never sent to anyone else before adjudication |
| `canAct` | the seat has something to order this phase |
| `host` | the seat that created the game |

### AI seats

Every AI seat is played every phase. The moment a phase opens the built-in bot's orders are on file for each AI seat and each seat on autopilot, so an AI seat can never leave a phase without orders or hold one up.

A game that sets `aiBrain: "claude"` on a server that holds an API key then asks Claude for better orders. Claude seats use no part of this protocol and hold no token: their turns travel through an internal queue as `{ gameId, power, phase, step }` and reach the room over its private binding, which the internet cannot address. What they send is ordinary press and ordinary orders, subject to the same rules as a player's. A seat on autopilot is taken over the same way, under the same caps: Claude plays it until its player orders again. Orders from Claude never count as the player returning, and an answer that arrives after the player is back is refused.

A movement phase is played in two steps, both visible to the table as `seats` frames (`ready` stays false for a Claude seat until its orders are in):

1. **Negotiate.** Each seat reads the press so far and sends up to three messages and at most one pledge. Talks close after 60 seconds.
2. **Listen.** The room waits for the table to answer: a quarter of the phase, two minutes at most, or until every human who can act is ready.
3. **Order.** Each seat reads everything said in the phase, then submits orders. Orders are due 90 seconds later.

Retreat and adjustment phases, gunboat games and movement phases shorter than four minutes skip straight to step 3. Every limit is also capped by the phase deadline. When a limit passes, a call fails, the queue is down or the budget is spent, nothing has to happen: the orders already on file are adjudicated.

Spend is capped twice. Per game (5 US dollars unless the server says otherwise): the worst-case price of each call is reserved before it is made and the real price settled from the API's usage report, so the cap holds whatever the calls cost. A prompt is bounded in bytes, and a token is never shorter than a byte, so the reservation covers the bill in any script. And for the whole deployment: before a game starts, the index admits it to Claude only while the day's budget (20 US dollars, each admitted game counting for its whole cap until it ends and hands back what it did not spend) and the number of Claude games in play (4) allow it. A game that is not admitted, or that cannot reach the index, is played by the bot. `GET /api/games/:id` reports it as `ai: { brain, model, claudeTurns, claudeCalls, spentUsd, capUsd, tokens, stopped }`; `stopped` is null, or why the game went back to the bot (`spend_cap`, `model_failing`, `model_unauthorised`, `claude_games_full`, `claude_daily_budget`, `no_budget_authority`, `budget_unreachable`).

A seat in civil disorder still belongs to its player, whose token keeps working: submitting orders takes it back. After four missed movement phases the seat is vacant, and a seated player may open it to a substitute (see HTTP).

## Orders

`orders.set` replaces the seat's whole order list for the phase. Every order is judged against the board by the engine's own validator (the same check adjudication makes) before it is put on file, and `orders.ack.verdicts` reports each one in the order sent. `code` is one of the coarse codes below; a refused verdict also carries `detail`, the engine's finer reason (`unreachable`, `ambiguous_coast`, `support_self`, `convoy_no_route`, `occupied`, `standoff`, `not_home_center`, ...), and `reason`, a sentence a player can act on:

| verdict code | meaning |
|---|---|
| `ok` | legal; on file in canonical text (`order`) |
| `syntax` | the text is not an order |
| `foreign_power` | the order names another power |
| `no_such_unit` | the seat has no such unit (or, in a retreat phase, no such dislodged unit) |
| `illegal` | the unit exists but cannot be given that order on this board |
| `superseded` | a later order in the same list was for the same unit (or the same build province); the last one stands. Only orders that are legal on their own compete: an illegal correction is refused on its own and never displaces a good order |
| `over_allowance` | more builds or disbands than the seat is due; the first ones stand |

`accepted` lists what is on file and `rejected` repeats the refused orders as `{ text, reason }`. Sealed defaults (`orders.default`) are checked for syntax and ownership only, because the board they will be used on is not known yet.

A retreat is identified by the province the unit was dislodged from and where it goes: `A VEN R TUS` is accepted and put on file with the unit as `state.retreats` names it, whichever unit letter was sent.

An `orders.set` in which nothing is accepted (an empty list, or only refused orders) puts nothing on file: the seat's own earlier orders for the phase are withdrawn, so its sealed defaults apply again, and orders the bot filed for a seat in civil disorder are left standing. Sealed defaults stand in for a present player's missing movement orders; a phase resolved from defaults still counts as missed, so after two the seat is in civil disorder and the bot's orders replace them.

## Results

Each entry of `results` is the engine's `{ power, unit, order, ok, code, reason, summary?, by?, illegal?, submitted? }`. `code` is `ok`, `bounce`, `repelled`, `head_to_head`, `own_unit`, `no_path`, `cut`, `void`, `dislodged`, `paradox` or `illegal` (movement), `ok`, `bounce`, `illegal` or `disband` (retreats), `ok` or `illegal` (adjustments). `summary` says why in words with units named in full (`bounced with A MUN`); `by` lists the units behind a failure; an illegal order appears as a hold, with `illegal` naming why and `submitted` keeping what was asked. `reason` is the engine's terse log form, kept for older clients. `rejected` lists `{ power, input, code, reason }` for orders that never reached the board (unreadable, or for a unit the power does not have); the room files only orders it accepted, so it is usually empty.

## Press

Messages go to one power or to `ALL`. A seat reads public messages and the private ones it sent or received; a spectator reads public ones. `welcome.press` holds the latest 500; older ones are paged over HTTP. Read markers are kept per seat and thread: `press.read { with, upTo }` moves a marker forward, and `welcome.unread` and `press.unread` count what others have sent since.

## Draws

A draw passes when every surviving, present human player has voted yes in the current phase. Seats played by AI, seats in civil disorder and eliminated players are never required, so nobody absent can veto. With `dias: true` the draw is shared by all survivors. With `dias: false` every required voter must also name the same `include` set, and only the powers in it share the result: it still takes everyone to agree. Nobody is cut out of a draw without agreeing to it: `include` may leave out only powers that are required voters, so a survivor played by AI or in civil disorder always shares, and a proposal that omits one is refused with `bad_vote`. A ballot that repeats the one on file changes nothing and is not announced. Votes are cleared when the phase resolves. With `ghostVotes: true` an eliminated player may cast a vote that counts for nothing.

`votes` is `{ phase, draw, required, hidden, cast, yes }`. `required` lists the seats whose agreement is needed; `cast` and `yes` count how many of them have voted and voted yes, and are always public. With `publicVotes: true` (the default) `draw` lists every ballot as `{ power, value, include }`. With `publicVotes: false`, `hidden` is true and `draw` holds only the viewer's own ballot: the table sees the tally, never who cast it. A voter is then sent a `votes` frame of their own after the one everybody gets.

A draw is scored by the game's `scoring`: `sos` gives each sharer its centre count squared over the sum of squares, `dss` gives each sharer an equal part. A solo is always 1 to the winner.

## Pledges

1. Sender chooses orders to commit to. Open pledge: the recipient sees the orders. Sealed pledge: recipients see only `commitment = blake3(canonical(orders) || nonce)` until adjudication.
2. The client may pick the 16 byte hex `nonce` and send the `commitment` it computed with `pledgeCommit(orders, nonce)` over the canonical order text; the server then refuses the pledge (`bad_pledge`) unless its own commitment is identical. When no nonce is sent the server picks one. Either way the pledger sees `pledge.nonce` at once.
3. The server stores the pledge with the phase it applies to. Every pledged order must be one the pledger's own units can legally be given in that phase; anything else is refused with `bad_pledge` and the message is not sent.
4. After adjudication the engine judges the receipt against the board the phase started from (`game.pledgeReceipt`), comparing the pledged orders with the orders the pledger had on file, both in canonical text. Every pledged order present: `kept`. Any missing, including when the pledger had units and submitted nothing at all: `broken`. A pledge that never bound anything (the pledger had nothing to order), or a phase resolved by the all-hold fallback: `void`.
5. `pledge.receipt { pledgeId, receipt, revealed, nonce }` goes to the pledge audience and its pledger. The nonce is revealed with it, so anyone who holds the commitment can check `pledgeOpens(commitment, revealed, nonce)` for themselves. Until then `pledge.nonce` is null for everybody but the pledger.
6. Receipts are counted in the game's ledger. `GET /api/games/:id/ledger` and the replay list each resolved pledge with its commitment, nonce, orders and receipt: pledges made to `ALL` for anyone, private pledges for the two powers they concern, and every pledge once the game is over.
7. Receipts also count towards the pledger's own trust ledger across games (see Players), when the promise was made to another person in a game that meets the rated bar, at most one per audience per phase.

A seal protects a player from the other players, not from the server, which must see the orders to issue the receipt.

## HTTP

| method and path | purpose |
|---|---|
| `POST /api/games` | create a game from `{ name, settings? }`; returns `{ gameId, token, power }`. With a player secret as the bearer the creator sits under their handle and `name` may be left out |
| `GET /api/games` | `status=open` lists public lobbies with a free seat, `status=active` public games in play, `status=finished` (the default) finished and abandoned games that were created `public` and played at least one phase. Unlisted games are recorded for ratings and the ledger but never listed. `limit` (up to 100) and `before` page each list; `result` filters the finished one. Answers `{ status, games }` |
| `POST /api/games/:id/join` | `{ name, power? }` claims a lobby seat; `{ name, invite }` takes a vacated seat in a running game. Refused with 409 for a caller who presents a seat token for this game, and for a signed-in player who holds or has held any seat in it. A signed-in player may leave `name` out |
| `POST /api/games/:id/seat` | with a player secret: `{ gameId, token, power }`, a new seat token for the player's own seat (another device, a cleared browser). Tokens the seat already has keep working; a substitute's arrival retires them all |
| `POST /api/games/:id/start` | the host starts early; open seats become AI seats when `aiFill` is on. Answers the summary |
| `POST /api/games/:id/substitute` | `{ power }` with a seated player's bearer token: returns a one-time `invite` for a seat whose player has missed four movement phases |
| `GET /api/games/:id` | the public summary: `{ id, settings, status, phase, host, deadlineAt, serverTime, createdAt, seats, finished, pauseReason, pausedUntil, pausedRemainingMs, history, ai }` |
| `GET /api/games/:id/replay` | MILA-compatible saved game JSON, with one extra key `cabal`: `{ protocol, status, finished, pledges, history }` |
| `GET /api/games/:id/ledger` | `{ gameId, ledger, entries }`: kept, broken and void counts per power, and the resolved pledges the caller may read as `{ id, pledger, audience, phase, sealed, commitment, nonce, orders, receipt }` |
| `GET /api/games/:id/press` | `{ gameId, press, more }`: one page of press, oldest first. `before=<sentAt>` pages backwards, `with=<power or ALL>` narrows to one thread, `limit` is at most 200 |
| `GET /api/games/:id/ws` | the WebSocket |
| `GET /health` | `{ ok, protocol, engine, build, registry, index, time }`: the engine's version, the deployed build, whether the games index answers (`index: { backend, reachable, schema }`, backend `d1` in production) and whether the Registry that keeps the Claude budget answers (`registry: { reachable, schema }`). `ok` is false, and the status 503, while the index does not answer or its D1 schema is older than the build needs, so a build deployed before its migrations is caught at once |
| `POST /api/players` | `{ handle? }` makes a guest account on this device: `201 { player, secret }`. Without a handle the server picks one (`Envoy-4821`) |
| `POST /api/players/recover` | `{ code }` restores an account on this device from its recovery code: `{ player, secret }`, a new device session. 401 when the code is not valid |
| `GET /api/players/:handle` | the public profile, see Players. A handle given up in the last 90 days still finds its player |
| `GET /api/me` | the signed-in player's profile plus `account: { renameAvailableAt, recoveryIssuedAt, sessions }` |
| `PATCH /api/me` | `{ handle }` changes the handle: free the first time, then once every 14 days (429 `rename_cooldown` with `retryAt`). Answers like `GET /api/me` |
| `POST /api/me/recovery` | `{ recoveryCode, issuedAt }`: a new recovery code, shown once; any older code stops working |
| `POST /api/me/logout` | `{ everywhere? }` ends this device's session, or every session: 204 |
| `GET /api/me/games` | `{ games }`: the player's games, live and ended, listed or not, as `{ gameId, power, status, joinedAt, finishedAt, result, score, centers, ratingDelta }` |
| `GET /api/leaderboard` | `{ ladder, entries, offset, limit, next }`: established ratings, best first, each `{ rank, player, rating, rd, conservative, games, lastGameAt }`. `offset` and `limit` (up to 100) page it |
| `GET /api/ledger` | `{ entries, offset, limit, next }`: the global trust ledger, most trusted first, each `{ rank, player, trust, games }`, for players with at least three kept or broken pledges |
| `GET /api/push/key` | `{ publicKey }`: the VAPID public key to pass to `pushManager.subscribe` as `applicationServerKey`, null where push is off. Cacheable for five minutes |
| `POST /api/me/push` | with a player secret: a browser's `PushSubscription.toJSON()`, `{ endpoint, expirationTime?, keys }`. `201 { devices }`. The endpoint must be a known push service over https (`bad_endpoint`), the keys a P-256 point and a 16-byte secret (`bad_keys`). A player keeps their five newest devices; signing a device out forgets its subscription |
| `DELETE /api/me/push` | `{ endpoint }` forgets one of the player's subscriptions: 204 |
| `GET /api/me/notifications` | `{ preferences, devices, reminderMinutes }`: one switch per kind of notice (see Notifications), how many browsers are subscribed, and how long before a deadline the reminder goes out |
| `PATCH /api/me/notifications` | any of `{ deadline, phase, press, started, finished }`; the rest are kept. Answers like `GET` |
| `POST /api/metrics` | `{ samples }`, up to 10 of `{ metric, ms }` with `metric` `order_rtt` (an `orders.set` to its `orders.ack`, at most 60 s) or `landing_to_game` (landing page to a first phase that accepts orders). Anonymous: nothing about the sender is kept but the continent, and samples are folded into daily histograms (bins 5 percent wide). Gather samples and send one beacon when the page is hidden: an address may send 6 a minute (429 after), the deployment accepts 20,000 samples a day (later beacons are answered 204 and dropped), and a beacon from a page on another origin is refused (403). 204 |
| `GET /api/metrics` | admin (`Authorization: Bearer <ADMIN_TOKEN>`; 404 where none is set): `{ from, to, metrics }` over the last `days` (default 30), each metric `{ id, title, target, status, value, unit, samples, lastAt, detail }` with `status` `pass`, `fail` or `unmeasured` |
| `POST /api/metrics/datc` | admin: `{ passed, failed, skipped, commit, engine? }`, the DATC case totals for a commit. `201 { recorded }`, false for a report already recorded |

Bearer tokens go in the `Authorization` header, never in a URL. There are two kinds: a seat token (`<gameId>.<POWER>.<secret>`) speaks for one seat, a player secret (`cps_` and 48 hex characters) for one player. `ledger`, `replay` and `press` are public; a seat token widens them to that seat's private pledges and threads. A player secret that is not valid is a 401 `signed_out` wherever it is sent, never silently anonymous play. Create, join, substitute and seat recovery are rate limited per client address, as are reads, starts and socket upgrades; making and restoring accounts per address (10 a minute); changes to an account per player (20 a minute). Profiles, the leaderboard and the trust ledger may be cached for a minute; everything under `/api/me` and every answer that carries a secret is `private, no-store`.

Every answer is JSON with CORS headers (or an empty 204: signing out, removing a push subscription, a metrics beacon) and names its request in an `x-request-id` header. A request that fails inside the server is answered `500 { error: "internal error", requestId }`; the same `requestId` is on every structured log line the request wrote, in the Worker and in the room.

A listing from `GET /api/games?status=open|active` is `{ gameId, status, settings, cluster, hostName, humans, openSeats, phase, deadlineAt, createdAt, updatedAt }`. A finished game is `{ gameId, result, reason, winners, scores, settings, cluster, phaseCount, createdAt, finishedAt, ledger, seats, players?, movementPhases? }`. `players` lists every stint at every seat (who held it, from when, whether they were a substitute or left, phases due, ordered in time and ordered late, and the receipts that count towards their ledger); it is how ratings, reliability and the trust ledger are fed.

## Players

Identity is guest first. A device makes an account with `POST /api/players` and keeps the `secret` it is shown once; the server stores only its hash. There is no email, password or passkey. To play from another device, the player asks for a recovery code (`POST /api/me/recovery`, `CABAL-` and five groups of four characters, shown once) and redeems it there (`POST /api/players/recover`); each device gets its own secret, up to ten, and a new code retires the old one. Anonymous play needs none of this: a name is still enough to create or join a game.

Handles are 3 to 20 letters, digits, `_` or `-`, starting with a letter, and unique by how they read: whatever their case, with `_` and `-` alike, and with the characters that pass for one another alike (`0` and `o`; `1`, `i` and `l`; `5` and `s`; `rn` and `m`; `vv` and `w`), so `Envoy_4821` is taken when `Envoy-4821` exists, and a profile answers to any of those spellings. A handle is always shown as it was chosen. Names that pass for the house (`admin`, `system`, `Claude`, `Automaton`, ..., also as a part of a handle such as `Claude_AI` or `Mod_Team`, with a digit on the end, or spelt with look-alikes such as `CabaI` with a capital i) and the worst abuse are refused (`handle_reserved`, `handle_abusive`; `handle_shape` for the wrong shape; 409 `handle_taken`). The first change from a picked handle is free, then one change every 14 days; a handle given up stays its player's for 90 days, so old links resolve and nobody can take it at once.

A signed-in player sits under their handle and holds at most one seat per game, ever: they cannot take a second seat, nor come back as a substitute after leaving one.

A profile (`GET /api/players/:handle`) is `{ player, rating, reliability, trust, games, recent }`:

| field | meaning |
|---|---|
| `player` | `{ id, handle, createdAt }` |
| `rating` | null until a rated game, else `{ ladder, rating, rd, volatility, conservative, games, established, rank, lastGameAt }`. `rd` grows with time away; `rank` is the place on the leaderboard, null until established |
| `reliability` | `{ score, phasesDue, phasesOnTime, phasesLate, missed, gamesCompleted, gamesWalkedOut }` |
| `trust` | `{ score, kept, broken, void }`, the player's trust ledger |
| `games` | `{ played, solos, draws }` |
| `recent` | the 20 most recent ended public games, `{ gameId, power, result, score, centers, substitute, walkedOut, ratingDelta, finishedAt }` |

### Ratings

Skill is weighted pairwise Glicko-2, one game one rating period (see `docs/adr/0011-weighted-pairwise-glicko-2.md`). A game is rated when it was public, ended in a solo or a draw, lasted two full game years (four movement phases), and at least three distinct signed-in players held seats in it. Unlisted games are friendly games: they count for reliability, not for rating or the trust ledger.

Every pair of signed-in players at the table is scored `a / (a + b)` from their two shares of the result: a solo winner beats everyone, draw members split by Sum of Squares or evenly under Draw Size and beat everyone outside the draw, and two players who both scored 0 are not paired. Each pairing weighs `min(1, 2 / (N - 1))` for N rated players, so a full table moves a rating about as much as two head-to-head games. AI and anonymous seats are never rated and are not opponents: a deterministic bot would be a points farm. A player who left their seat to a substitute takes a share of 0; the substitute is rated on the seat's result but never loses rating for it. Each change is stored with a per-opponent breakdown that sums to it.

The leaderboard lists ratings with at least three games and a deviation of at most 200, played in the last 180 days, ordered by `rating - 2 * rd` (so an uncertain rating ranks low on its own).

### Reliability and the trust ledger

Reliability is `(onTime + 0.5 * late + 9) / (due + 10 + 4 * walkedOut)`, so a newcomer starts at 0.9. A phase is due when the player's seat had something to order; on time when the player filed orders before the deadline, late when only in the grace period, missed otherwise. A game is walked out of when the player's seat went to a substitute or was in civil disorder at the end.

The trust ledger counts the receipts of a player's pledges across games, `(kept + 5) / (kept + broken + 10)`, starting at 0.5; void receipts are shown but do not move it. Only a promise made to another person counts: to a power another signed-in player held when it was made, or to `ALL` in a game with at least two signed-in players. Pledges to AI seats, anonymous seats or oneself stay in the game's own ledger. Only games that meet the rated bar count (public, a solo or a draw, two game years, three distinct signed-in players), so two accounts in an unlisted game, or a table that votes a draw after one phase, cannot fill a ledger with promises they arranged to keep. And a promise is counted once per audience per phase, however many pledges repeat it: broken if any of them was broken, else kept, else void.

## Notifications

A signed-in player who subscribes a browser (`POST /api/me/push`) is told by Web Push when a game needs them and they are away from it, that is when no socket is open for their seat. Someone with the game open is never pushed. The five kinds, each with a switch in `PATCH /api/me/notifications`, all on until turned off:

| kind | when |
|---|---|
| `started` | the game began; says which power the player has |
| `phase` | a phase resolved and the player has orders to write in the next one |
| `press` | a private message arrived for the player's power; never its text. Once per sending power per phase: later dispatches from that power in the same phase are silent |
| `deadline` | `reminderMinutes` before the deadline, once per phase, when the player can act and has not filed orders or readied; only in phases at least twice that long |
| `finished` | the game ended in a solo, a draw, or was abandoned |

A push message is encrypted to the browser (RFC 8291, `aes128gcm`) and decrypts to `{ kind, gameId, title, body, url, tag, sentAt }`. `url` is the game's path on the web app (`/g/K7Q2AB`), `tag` replaces an earlier notice of the same kind for the same game on the device (for `press`, of the same kind from the same power, so dispatches from two powers stay apart). A push never carries orders, press text, pledges or a token. Delivery is best effort and never holds up a game; a subscription the push service reports gone is deleted.

## Client library

`@cabal/protocol/client` exports `CabalSocket` (hello, resume by `seq`, backoff with jitter, keepalive, requests matched to replies by `id`) and `createApi` (typed calls for every route above, the player routes included; a player secret is passed as the bearer). Both take their transport as an argument, so the same code runs in a browser, in Node and inside workerd tests.

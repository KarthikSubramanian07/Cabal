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
{ "t": "<type>", "id": "<client message id, optional>", "p": { ... } }
```

`orders.ack`, `press`, `extend.ack`, `welcome` (after `hello`), `synced` and `error` echo the `id` of the frame they answer. Frames are JSON text of at most 4 KB. Every frame spends the socket's rate limit (burst 30, 10 per second; `sync` costs five). The server answers the text `ping` with `pong` without waking the room.

## Connecting

Open `GET /api/games/:id/ws`. The socket is a spectator at once and receives a `welcome` with `power: null`. A player then sends `hello { token }` as the first frame, which binds the socket to the seat and is answered with that seat's `welcome`. Seat tokens never appear in a URL: a `?token=` query is refused with 400. A bad token gets `error bad_token` and close code 4401. When a seat changes hands its open sockets are closed with code 4001.

Spectators are read-only: every frame except `hello` and `sync` is answered `error spectator`.

## Client to server

| type | payload | notes |
|---|---|---|
| `hello` | `{ token }` | binds the socket to a seat; answered with `welcome` |
| `orders.set` | `{ phase, orders: string[] }` | replaces the seat's orders for the phase; from a seat in civil disorder, at least one accepted order takes the seat back |
| `orders.default` | `{ orders: string[] }` | sealed movement orders used if the seat misses a deadline (the phase still counts as missed) |
| `ready` | `{ phase, ready: boolean }` | the phase resolves when every seat that can act is ready |
| `extend` | `{ phase }` | asks for more time; granted once per phase when two present players (or the only one) ask |
| `press.send` | `{ to: power or "ALL", body, pledge? }` | `pledge` is `{ orders: string[], sealed: boolean, nonce? }` |
| `vote` | `{ kind: "draw", value: boolean, include?: power[] }` | `include` names the sharers of a non-DIAS draw; absent means every survivor |
| `sync` | `{ since: seq }` | replays up to 500 stored frames after `since`, then `synced` |

## Server to client

| type | payload | notes |
|---|---|---|
| `welcome` | `{ gameId, settings, status, pauseReason, pausedUntil, pausedRemainingMs, power, phase, state, seats, deadlineAt, seq, orders, press, votes }` | full snapshot; `power` is null for a spectator |
| `state` | `{ phase, state, deadlineAt, seq, status }` | after every adjudication and at the end of the game |
| `results` | `{ phase, results, dislodged, standoffs, civil_disorder, seq }` | per-order outcomes with reasons |
| `orders.ack` | `{ phase, accepted: string[], rejected: [{ text, reason }] }` | |
| `press` | `{ id, phase, from, to, body, sentAt, pledge }` | `pledge.orders` is null for a sealed pledge until its receipt |
| `pledge.receipt` | `{ pledgeId, receipt: "kept" or "broken" or "void", revealed }` | to the pledge's audience and its pledger, after adjudication |
| `seats` | `{ seats: [{ power, kind, name, ready, eliminated, missed, autopilot }] }` | join, ready, civil disorder, recovery, substitution |
| `deadline` | `{ phase, deadlineAt, grace? }` | `grace: true` marks the one-off grace period; `deadlineAt` is null while paused |
| `extend` | `{ phase, requestedBy, needed, granted, deadlineAt }` | to everyone on each request, so a second player can see one is pending |
| `extend.ack` | `{ phase, requests, extended }` | to the requester |
| `votes` | `{ phase, draw: [{ power, value, include }], required }` | on every vote, and emptied when the phase resolves |
| `status` | `{ status, reason, until? }` | lifecycle changes: `active`, `paused` (with the time the pause ends by itself), `finished`, `abandoned` |
| `finished` | `{ result: "solo" or "draw" or "abandoned", winners, scores, reason }` | |
| `synced` | `{ seq, more }` | ends a `sync` reply; send `since: seq` for the next page while `more` is true |
| `error` | `{ code, message }` | see below |

Error codes: `rate_limited`, `too_large` (the socket is then closed with 1009), `bad_json`, `bad_frame`, `bad_token`, `too_many_sockets`, `spectator`, `not_active`, `seat_inactive`, `stale_phase`, `bad_order`, `no_press`, `public_only`, `press_closed`, `press_limit`, `whisper_budget`, `press_rate_limited`, `bad_pledge`, `bad_vote`, `extension_used`, `adjudication_retry`, `adjudication_fallback`.

## Game status

`lobby`, `active`, `paused`, `finished`, `abandoned`.

- `paused` happens only in `live` pacing, when every human player has disconnected. The phase clock stops with its remaining time banked, the pause ends by itself (at most ten minutes of pause per phase) and the game resumes with exactly that time. Daily and async games never pause.
- `finished` carries a result of `solo` or `draw` and a reason: `solo`, `vote`, `engine_draw`, or `no_humans_left` (no human power survives on the board).
- `abandoned` carries a reason: `no_orders` (three movement phases without a human order), `lobby_expired` (a lobby not started within a week) or `adjudication_failed`.

## Seats

| kind | meaning |
|---|---|
| `open` | unclaimed, in the lobby |
| `human` | a player's seat |
| `ai` | played by the built-in bot, or by Claude when the game sets `aiBrain: "claude"` and the server has a key |
| `civil_disorder` | its player has missed two movement phases; `autopilot: true` means the bot is covering it |

A seat in civil disorder still belongs to its player, whose token keeps working: submitting orders takes it back. After four missed movement phases the seat is vacant, and a seated player may open it to a substitute (see HTTP).

## Draws

A draw passes when every surviving, present human player has voted yes in the current phase. Seats played by AI, seats in civil disorder and eliminated players are never required, so nobody absent can veto. With `dias: true` the draw is shared by all survivors. With `dias: false` every required voter must also name the same `include` set, and only the powers in it share the result: it still takes everyone to agree. Votes are public (`votes` frames) and are cleared when the phase resolves. With `ghostVotes: true` an eliminated player may cast a visible vote that counts for nothing.

## Pledges

1. Sender chooses orders to commit to. Open pledge: the recipient sees the orders. Sealed pledge: recipients see only `commitment = blake3(canonical(orders) || nonce)` until adjudication.
2. The server stores the pledge with the phase it applies to.
3. After adjudication the server compares the pledged orders to the orders the pledger actually submitted for that phase. Every pledged order present: `kept`. Any missing: `broken`. Nothing submitted, or the phase resolved by the all-hold fallback: `void`.
4. Receipts go to the pledge audience and its pledger, and are counted in the game's ledger.

## HTTP

| method and path | purpose |
|---|---|
| `POST /api/games` | create a game from `{ name, settings? }`; returns `{ gameId, token, power }`. Clock settings left out come from the pacing preset |
| `GET /api/games` | recently finished and abandoned games from the Registry (`limit`, `before`, `result`) |
| `POST /api/games/:id/join` | `{ name, power? }` claims a lobby seat; `{ name, invite }` takes a vacated seat in a running game. Refused with 409 for a caller who presents a seat token for this game |
| `POST /api/games/:id/start` | the creator starts early; open seats become AI seats when `aiFill` is on |
| `POST /api/games/:id/substitute` | `{ power }` with a seated player's bearer token: returns a one-time `invite` for a seat whose player has missed four movement phases |
| `GET /api/games/:id` | public summary |
| `GET /api/games/:id/replay` | MILA-compatible saved game JSON |
| `GET /api/games/:id/ledger` | kept, broken and void pledge counts per power |
| `GET /api/games/:id/ws` | the WebSocket |
| `GET /health` | liveness |

Bearer tokens go in the `Authorization` header. Create, join and substitute are rate limited per client address, as are reads, starts and socket upgrades.

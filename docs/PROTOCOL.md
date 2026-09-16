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

Server replies to a client message with the same `id` when the message has one.

## Client to server

| type | payload | notes |
|---|---|---|
| `hello` | `{ token }` | first message, binds the socket to a user and seat |
| `orders.set` | `{ phase, orders: string[] }` | replaces the seat's orders for the phase |
| `orders.default` | `{ orders: string[] }` | sealed defaults used if the seat misses the deadline |
| `ready` | `{ phase, ready: boolean }` | ready to advance |
| `press.send` | `{ to: power or "ALL", body, pledge? }` | `pledge` is `{ orders: string[], sealed: boolean, nonce? }` |
| `vote` | `{ kind: "draw", value: boolean }` | |
| `sync` | `{ since: seq }` | request events after a sequence number |

## Server to client

| type | payload | notes |
|---|---|---|
| `welcome` | `{ game, seat, power, phase, state, deadline, seq }` | full snapshot on join |
| `state` | `{ phase, state, deadline, seq }` | after adjudication |
| `results` | `{ phase, orders, outcomes, explanations }` | per-order outcomes with reasons |
| `orders.ack` | `{ phase, accepted: string[], rejected: [{ text, reason }] }` | |
| `press` | `{ id, from, to, body, pledge?, sentAt }` | pledge carries `commitment` when sealed |
| `pledge.verdict` | `{ pledgeId, verdict: "kept" or "broken" or "void", revealed?: string[] }` | after adjudication |
| `seats` | `{ seats: [...] }` | join, leave, ready, civil disorder changes |
| `deadline` | `{ phase, deadlineAt }` | |
| `finished` | `{ result: "solo" or "draw", winners, scores }` | |
| `error` | `{ code, message }` | |

## Pledges

1. Sender chooses orders to commit to. Open pledge: the recipient sees the orders. Sealed pledge: recipients see only `commitment = blake3(canonical(orders) || nonce)` until adjudication.
2. The server stores the pledge with the phase it applies to.
3. After adjudication the server compares the pledged orders to the orders actually submitted for that phase by the pledger. Every pledged order present: `kept`. Any missing: `broken`. Pledger eliminated or phase skipped: `void`.
4. Verdicts broadcast to the pledge audience and update the trust ledger.

Verification is deterministic and reproducible from the saved game, so anyone can audit a ledger from the replay.

## HTTP

| method | path | purpose |
|---|---|---|
| `POST /api/games` | create a game from lobby settings | |
| `POST /api/games/:id/join` | claim a seat, returns a socket token | |
| `GET /api/games/:id` | public summary and current public state | |
| `GET /api/games/:id/replay` | MILA-compatible saved game JSON | |
| `GET /api/players/:id` | profile, ratings, trust ledger | |

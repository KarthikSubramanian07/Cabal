# ADR 0011: Weighted pairwise Glicko-2, with reliability and the trust ledger kept apart

Status: accepted (2026-11-19).

## Context

Diplomacy is a seven-player game that ends in a solo, a shared draw, or nothing. Rating systems are built for two players. The reference is the rating design of the current Diplicity (`docs/rating/00-design.md` in johnpooch/diplicity-react, calibrated on 2,267 real games; read for its ideas, no code taken): decompose a game into pairings, weight each pairing `2/(N-1)` so one table does not count as six separate games, rate humans only, never punish a replacement for taking over a lost position, and keep conduct out of skill.

Diplicity uses Glicko-1. The owner chose Glicko-2. With one game per rating period the volatility term moves little, which is harmless: it starts at 0.06 and stays near it until a player's results become genuinely erratic, and the rest of the algorithm is Glicko-1's.

## Decision

Skill (`apps/server/src/ratings.ts`, pure functions):

- One game is one Glicko-2 rating period (Glickman 2013, tau 0.5, a newcomer at 1500, 350, 0.06). Results are weighted: `v = 1 / sum(w g^2 E (1 - E))`, `delta = v sum(w g (s - E))`. With every weight 1 this is Glickman's algorithm exactly, and the test suite reproduces his worked example.
- Every pair of rated players at the table is scored `a / (a + b)` from their two shares of the result. A solo winner beats everyone; draw members split by Sum of Squares or evenly under Draw Size, and beat everyone outside the draw; two players who both scored 0 are not paired, because the game says nothing about which was better.
- Each pairing weighs `min(1, 2 / (N - 1))` for N rated players: a full table is worth about two head-to-head games, and a small one never more than one game per opponent.
- A game is rated when it was public, ended in a solo or a draw, lasted four movement phases (two game years, so a quick agreed draw cannot be farmed), and seated at least three distinct signed-in players. Unlisted games are friendly games.
- AI and anonymous seats are never rated and are not opponents. A deterministic bot would be a points farm, and an anonymous seat has no rating to compare with. A mixed game is rated on its human pairings alone.
- A player who left their seat to a substitute takes a share of 0. The substitute is rated on the seat's result but never loses rating from it (their deviation still shrinks).
- Inactivity grows the deviation lazily, one rating period of volatility per 30 days, never past 350.
- The leaderboard lists ratings with at least three games and a deviation of at most 200, active in the last 180 days, ordered by `rating - 2 * rd`. A loser of a solo is paired only with the winner, so deviations fall slowly; ordering by the conservative rating keeps uncertain ratings low without hiding them for a dozen games.
- Each change is stored with a per-opponent breakdown (`rating_history.opponents_json`) that sums exactly to it.

Conduct, shown beside skill and never folded into it:

- Reliability: `(onTime + 0.5 * late + 9) / (due + 10 + 4 * walkedOut)`. A phase is due when the seat had something to order; late means ordered only in the grace period; a game is walked out of when the seat went to a substitute or was in civil disorder at the end. A newcomer starts at 0.9.
- Trust: `(kept + 5) / (kept + broken + 10)`, a newcomer at 0.5; void receipts are shown and do not count. Only a pledge made to another person counts: to a power another signed-in player held when it was made, or to the whole table when at least two signed-in players sat at it. Only games that meet the rated bar feed it, and a promise counts once per audience per phase (broken over kept over void), because a ledger fed by unlisted or one-phase games could be filled by two accounts with promises they arranged to keep.

## Consequences

- A newcomer reaches the board after three to eight full tables, depending on how often they share draws.
- One ladder (`overall`) for now; ratings are keyed by ladder so press modes or variants can get their own.
- Nation handicaps (diplicity rates a win as Italy above a win as France) are left for when there is enough data to estimate them.
- The rules are constants in one module, so changing a threshold is a one-line change plus a re-rate script, which does not exist yet.

# Rules decisions

Cabal follows the 2023 Renegade rulebook as codified by Lucas Kruijswijk's Diplomacy Adjudicator Test Cases (DATC) v3.0. Every issue in DATC chapter 4 has a recorded choice below. Where DATC offers a preference, we take it. Where our product needs differ, the reason is stated.

Rulebook editions are data in the engine (`Rulebook::edition_2023()`, `edition_1982()`, `edition_1971()`, `dptg()`), so tests tagged with an edition run under it.

## Movement

| DATC | Issue | Cabal choice |
|---|---|---|
| 4.A.1 | Multi-route convoy disruption | Convoy fails only if every route is disrupted |
| 4.A.2 | Convoy paradoxes | Szykman rule: convoys in the paradox core fail; supports are not cut |
| 4.A.3 | Convoy to adjacent province | 2023: convoy used if `via convoy` is stated or a same-power fleet is ordered to convoy. No fallback to land when disrupted. DPTG edition requires explicit `via convoy` |
| 4.A.4 | Support cut by attack on itself via convoy | Not cut (attack is from the army's origin) |
| 4.A.5 | Retreat when dislodged by adjacent convoy | May retreat to the attacker's origin |
| 4.A.6 | Convoy path in order | Not allowed, ignored if given |
| 4.A.7 | Dislodged unit bouncing a third unit at attacker's origin | Only loses its effect in a true head-to-head |
| 4.E.1 | Illegal orders | Impossible-without-context orders are illegal and ignored (unit holds, may receive hold support). Non-matching support or convoy is void but still an order |
| 4.E.2 | Poorly written orders | Judge each order on its own |
| 4.E.3 | Implicit orders | Not allowed |
| 4.E.4 | Perpetual orders | Not allowed |
| 4.E.5 | Proxy orders | Not allowed |

## Coasts

| DATC | Issue | Cabal choice |
|---|---|---|
| 4.B.1 | Omitted coast, two possible | Move fails (illegal). The UI never lets a human submit this |
| 4.B.2 | Omitted coast, one possible | Move to the only possible coast |
| 4.B.3 | Impossible coast | Illegal |
| 4.B.4 | Coast in support order | Support may omit the coast; if given it must be reachable |
| 4.B.5 | Wrong coast of ordered unit | Ignored, unit's real coast used |
| 4.B.6 | Unknown or irrelevant coast | Ignored |
| 4.B.7 | Build fleet in StP without coast | Build fails |

Coast inference (4.B.2, 4.B.5, 4.B.6) lives in the order normalisation layer, not the resolver, so the resolver only ever sees fully specified regions.

## Unit type and nationality

| DATC | Issue | Cabal choice |
|---|---|---|
| 4.C.1, 4.C.2 | Missing or wrong unit type | Order valid, real type used |
| 4.C.3 | Missing type in build | Army inland; fleet if a coast is given; otherwise fails in a coastal province |
| 4.C.4 | Fleet build inland | Fails |
| 4.C.5, 4.C.6 | Missing or wrong nationality in support or convoy | Valid, ignored |

## Too many or too few orders

| DATC | Issue | Cabal choice |
|---|---|---|
| 4.D.1, 4.D.2 | Multiple order sets | Latest submission replaces earlier ones (the server keeps a history) |
| 4.D.3 | Multiple orders to one unit | The UI prevents it; engine treats all as illegal, unit holds |
| 4.D.4, 4.D.6 | Too many builds or disbands | First legal ones in submission order are used |
| 4.D.5 | Two builds in one province | First used |
| 4.D.7 | Waiving builds | Allowed |
| 4.D.8 | Civil disorder removals | 2023 rule: distance to nearest owned supply centre, armies and fleets both traverse land and sea for distance; farthest first; ties fleets before armies then alphabetical by province name |
| 4.D.9 | Hold support for a civil-disorder unit | Succeeds |

## Retreats

- No supports or convoys in the retreat phase; such orders are rejected at parse time.
- A dislodged unit may not retreat to an occupied province, the attacker's origin (except when dislodged by a convoyed army), or a province left empty by a standoff this turn.
- Two or more retreats to the same province all disband.
- Coastal retreats obey coast reachability; a fleet may not "coastal crawl" (6.H.15).

## Builds

- Only in owned, unoccupied home supply centres. Fleets need a coast in StP. Waive is allowed.
- Variants may set `build_anywhere`.

## Game end and scoring

- Solo: 18 supply centres after a Fall adjustment.
- Draw: vote among surviving powers. DIAS (all survivors share) by default; non-DIAS is a lobby option.
- Scoring for draws: Sum-of-Squares by default; Draw-Size Scoring as an option.
- Eliminated players keep press and one draw vote (ghost votes) when the lobby option is on.

## Deadlines and civil disorder

- Missing orders use the seat's sealed defaults if any, otherwise hold. Missed phases count against the reliability rating.
- Two consecutive missed movement phases put the seat in civil disorder and open it to substitutes and AI takeover.

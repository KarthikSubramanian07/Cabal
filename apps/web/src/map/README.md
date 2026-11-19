# The board and its moving parts

Everything a screen needs to show a Diplomacy position, play a resolved phase on it, explain a
result and scrub through a game. The sandbox (`pages/SandboxPage.tsx`) is the reference user;
the room and `/replay/:code` use the same pieces. Props are documented in TSDoc on each type;
this page is the map of what to reach for.

| Need | Use | From |
|---|---|---|
| Draw a position and take taps | `<Board>` | `map/Board.tsx` |
| Play a resolved phase (march, bounce, knock aside, retreat, build) | `Board` prop `resolution` | `map/Board.tsx`, `motion/choreography.ts` |
| Pick out the units behind one result | `Board` prop `highlight` | `map/Board.tsx` |
| Show a what-if sketch | `Board` props `sketch`, `ghosts`; `useWhatIf` | `game/explain/whatIf.ts` |
| Explain a result | `explainPhase`, `whyOf`, `whyOfResult`, `<WhyPanel>` | `game/explain/` |
| Scrub through a game | `<ReplayScrubber>` with `timeline(history)` | `motion/` |
| Sounds | `deck`, `useSound` | `sound/deck.ts` |

## `<Board>`

```tsx
<Board
  board={board}              // geometry from loadBoard()
  state={state}              // the position to draw (while a resolution plays: the one it began from)
  orders={drawn}             // DrawnOrder[]: { power, text, ok? }
  resolution={resolution}    // optional: a resolved phase to play, see below
  rate={1}                   // playback speed (a replay at 2x passes 2)
  onSettled={(key) => {}}    // every animation of the phase has run out (at any mix of speeds), or Skip
  highlight={why?.highlight} // optional BoardHighlight: focus, allies, against, units
  sketch={false}             // the orders are a what-if: stamped "What if"
  ghosts={[]}                // dashed pieces where a sketch would leave units
  standoffs={outcome.standoffs}
  selected={province} targets={set} hot={set}   // order entry, as before
  ids={unitIds} focus={provinces} focusKey={n} onProvince={(code, at) => {}}
/>
```

`Resolution` is `{ key, phase, before, after, results, beforeIds?, afterIds? }`: the positions
either side of the phase (`after` is `outcome.next`), the engine's results and the unit ids
from `trackUnits` for both, so each piece is walked rather than swapped. The choreography
plays once per change of `key`. For a room, a `results` frame plus the `state` frame before it
is everything needed: ids can come from `trackUnits([{ state, outcome }], next)`.

The board draws the map once and puts pieces and order marks on a second, composited layer
(`svg.board-live`), so a moving piece never repaints the map. It owns a small tool group over
the map: the sound switch, and **Skip** while a phase is playing. Escape skips too (unless focus
is in a text field, a select, an open dialog or a menu). When Skip goes, pressed or because the
phase ended, focus that was on it moves to the sound switch beside it, never to the page.
A change of `rate` mid-phase retimes the running animations and reschedules the sounds still
to come; the phase settles when its animations have finished, not on a timer. Once settled, the
land is tinted from `resolution.after`. Stepping through phases faster than they play gives a
telegraph tick per phase instead of each phase's whole set of sounds.

A highlight names provinces. Before a retreat phase a province can hold two units, the one that
took it and the one dislodged from it; every result of that phase is the dislodged unit's, so
the board rings that one (where it stood, if it was disbanded). `trackAt(plan, province)` in
`motion/choreography.ts` makes that choice.

Order marks are laid out by `map/marks.ts` with the geometry in `map/geometry.ts`: moves are
bowed strokes with a barbed head, supports dashed with a round knot on the middle of the move
they back, convoys dotted with a square knot, holds a solid ring, a move by convoy drawn through
its fleets. Every width is a share of the piece radius the board picks for the zoom, and every
kind differs in shape, so the marks hold at any zoom and without colour vision.

## Motion

`choreograph(input, marks, geometry, { reduced })` (`motion/choreography.ts`) is pure: it gives
each piece absolute frames, each mark its delay and stamp time, the cues for the sound deck,
and the total length. Four beats: the units that stand are inked; the moves are drawn and the
pieces march along their own arrows (a failed move gets a third of the way and recoils); a unit
beaten out is knocked aside as its attacker arrives; then every failure is stamped and the
standoffs wash in. Retreats walk from where the unit stood aside, builds stamp in, disbands fade.

Under `prefers-reduced-motion: reduce` nothing travels: marks are simply there and each moved
piece dissolves from its old place into its new one in 420 ms. `resolutionLength` gives the
length without geometry, for a replay's dwell.

## Explanations and what-if

`explainPhase({ phase, state, orders })` re-runs the engine's `explainPreview` on a phase from
the position it began with, so a replay or a room can explain any movement phase it has the
record of, without the game's history. `whyOf(explanation, index, names)` turns one order's
explanation into what `<WhyPanel>` shows (a sentence, strengths as a tally, supports and who cut
them, convoys and what broke them, the circle and rule of a paradox) and the `highlight` for the
board. Retreats and adjustments fall back to `whyOfResult`.

`useWhatIf(state, kind)` keeps a sketch order book apart from the real one and predicts it with
the engine's `preview` and `explainPreview` on every change. Nothing is sent and the game is not
touched. In a room, start it from the player's own orders and let them guess at the others.

## `<ReplayScrubber>`

```tsx
<ReplayScrubber
  marks={timeline(history)}  // one PhaseMark per resolved phase
  index={viewing ?? history.length}
  onSeek={(i) => {}}
  liveLabel="Spring 1903 movement, now"
  phaseLabel={(m) => `${m.season} ${m.year} results`}  // optional
/>
```

A native range input over a drawn timeline: a tick per phase, a glyph where something happened
(a unit dislodged, centres changing hands, builds, a power eliminated, the end), and the year
under each spring. The spoken value names the phase and what happened in it.

## Sound

`deck.play(name)` and `deck.schedule(cues, { rate, from })` (`sound/deck.ts`; `from` starts part
way into a run, for a speed changed mid-phase). Five voices synthesised with
the Web Audio API (`sound/voices.ts`): stamp thud, quill scratch, march, seal crack, telegraph
tick. Off by default and kept per device; no audio context exists until the player turns sound
on, and for a player who left it on, it is made on their first tap or key press (Safari only
starts audio from a gesture); the page asks to be ambient audio so the phone's silent switch
silences it; nothing plays in a hidden tab. `<Board>` plays its own phase's cues; pass `sound={false}` to keep a board quiet.

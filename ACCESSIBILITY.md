# Accessibility

Cabal aims to meet [WCAG 2.2](https://www.w3.org/TR/WCAG22/) Level AA in the web client
(`apps/web`): the sandbox board, the How to play dialog and the trust pages (about, contact,
privacy, 404).

## Playing without a mouse or without sight

- **Orders from the keyboard.** Under the map, a list of choices offers exactly what a click on
  the board would: first the active power's units, then the provinces the selected unit can move,
  retreat, support or convoy into, and in winter the provinces where a build or disband is legal.
  The choices call the same order composer as the map, so they can only produce legal orders.
  Move, Support, Convoy, Hold, Disband and Cancel are buttons, and coast choices open as a menu
  that arrow keys move through.
- **Announcements.** A polite live region says each order as it is given, a summary of every
  adjudication (how many orders succeeded and failed, dislodgements, standoffs, the next phase or
  the winner), and where you are when you step through the phase history.
- **Board as text.** "Board as text", under the map, lists every power's units and supply centres
  by name. It is the text alternative for the map and is visible, so it also serves anyone who
  cannot tell the power colours apart. Results list each order with a tick or cross and the words
  "succeeded" or "failed" for screen readers.
- **Shortcuts.** The single-key shortcuts (M, S, C, H, D) can be switched off in How to play, for
  speech input users and anyone who triggers them by accident.
- **Map controls.** Zoom has buttons, and once zoomed in, pan buttons replace dragging. On a
  phone the map opens zoomed on the open power's part of the board, and the four pan buttons are
  folded behind one "Move the map with buttons" button so they do not cover the map; pinch and
  drag work as well.
- **Phones.** Up to 1000 px wide the map fills the first screen with the order tools under it,
  and the power table, order list and results are a sheet docked to the bottom whose handle
  always shows the phase, what the open power still owes and the phase's main button. The site
  links are behind a Menu button. Nothing scrolls sideways from 320 px up.
- **Target size.** On touch screens and narrow windows every control is at least 44 by 44 CSS
  pixels. With a mouse the smallest are 24 by 24, the WCAG 2.2 minimum. Both are checked by test.
- **Headings and landmarks.** The phase ("Spring 1901 Movement") is a heading, so it can be
  reached by heading navigation, as are the choices under the map and each power in the results.
- **Nothing is lost by accident.** The game is saved on the device after every order and every
  adjudication and restored on the next visit, with a notice. Starting a new game and importing
  a file over a game in progress both ask first, in a dialog that focuses the safe answer.
- **The open power follows the work.** When a phase begins and the open power has nothing to
  order (only Austria retreats, only England builds), the first power that does is opened, so
  the choices under the map are never empty while orders are owed.

## How it is tested

Every pull request runs these in Chrome at 1280x720 and on an emulated iPhone 15 (390x844), as
part of `pnpm test:e2e` (`apps/web/e2e`):

- axe-core 4.14 with the WCAG 2.0, 2.1 and 2.2 A and AA rules over a whole game year (orders
  written, results, a retreat phase, winter builds), the coast menu, the How to play, new game
  and restored-game states, every reserved page, every trust page and the failed-to-load page.
  Serious and critical findings fail the build.
- Target sizes, the phone layout at 390x844 and on its side, no sideways scrolling, province
  codes of 10 px at the default zoom, and every ordering flow (move, support, convoy, retreat,
  disband, build, waive) by touch as well as by mouse.
- The keyboard path: the choices under the map, the coast menu, focus after adjudicating, and
  the arrow keys stepping through results only when focus is on the board.
- The games room and a table's lobby, against a local game server (`pnpm test:e2e:live`,
  `apps/web/e2e-live`): axe over the create dialog, the lobby as host and while choosing a seat,
  a game in play and the games room. Table talk is a named log region, so new messages are read
  out; every form error is an alert tied to its field; the seat picker's open seats are toggle
  buttons that say which seat is chosen.
- The live game room, by two players on two devices and a spectator (`e2e-live/game.spec.ts`):
  axe over the order desk, press with a sealed pledge, the results, the spectator's view and the
  final scores. Each press thread is a named log region and each thread button says its unread
  count; every seat in the seat strip carries its whole state as text, not only a colour and a
  word; the phase clock is said out loud at five minutes and at one; a private dispatch that
  arrives while the press is closed is announced; and a seal's receipt is stamped as an image
  with a text name ("Receipt: Kept") with the device's own check written out beneath it.
- The front door, the account, the records and the replay (`e2e/landing.spec.ts`,
  `account.spec.ts`, `records.spec.ts`, `notifications.spec.ts`): axe over the front door at rest
  and with the handle dialog open, the account card with a recovery code on show, a player's
  record, the Ledger (full and empty) and a finished game's replay at its end; and, against the
  real server (`e2e-live/front.spec.ts`), a player's own record and a replay.

## The front door, the account and the records (2026-11-19)

- The front door's one moment of motion (the dispatch, the seal, the order drawn across the
  Channel and the BROKEN stamp) runs only without `prefers-reduced-motion`; with it the story is
  drawn at once, finished, and no animation is created at all (tested). The dispatch has a
  written caption that tells the whole story for a screen reader.
- The headline is in the HTML the edge sends, before any script runs, and the browser takes the
  same markup over in place; nothing redraws or moves when it does.
- The player button's accessible name contains its visible text ("Your account", or the handle,
  read as "Your account, ada"), as WCAG 2.5.3 asks. Its menu closes on Escape and returns focus
  to the button.
- The handle and restore dialogs say what a handle may be before anyone types, and every refusal
  (taken, reserved, too short, a bad recovery code) is an alert tied to its field, with focus
  returned to it. A recovery code is shown in a labelled, focusable slip and can be copied or
  saved as a file.
- The rating chart is a group of points, each a keyboard stop with a spoken label (what the game
  did, and the rating after it); the same figures are in a table under "The figures". Results
  read as words (Won, Drew, Left), never only a colour; the reliability strip is a picture of
  the sentence beside it.
- The Ledger's standings are tables with captions; the two orders are tabs; the viewer's own row
  is marked in words ("you") as well as colour.
- A replay is the sandbox's phase player: the slider, the stepper and Space to play and pause,
  with each phase announced as it is shown.
- The browser's notification prompt is only ever raised by a button that says what it turns on.

## Motion, sound and explanations (2026-11-19)

- A resolved phase plays on the board: pieces march, bounce, are knocked aside and are built.
  It lasts one to three seconds, a **Skip** button (or Escape, from anywhere but a text field or
  a menu) stops it at its end state (WCAG 2.2.2). When Skip goes away, because it was pressed or
  the phase finished, focus that was on it moves to the Sound button beside it, never to the
  page (WCAG 2.4.3). Under `prefers-reduced-motion: reduce` nothing travels: marks appear and
  each moved piece dissolves into its new place. The results are announced in the live region either way.
- Order marks differ in shape as well as colour (WCAG 1.4.1): solid moves with a barbed head,
  dashed supports with a round knot, dotted convoys with a square knot, rings for holds, a cross
  for every failure. Highlighted units are ringed in brass (the order), dashed brass (helpers) or
  ringed with sights (against it).
- Sound is off until the player turns it on with the Sound button over the map (its state is
  `aria-pressed`); it carries no information that is not also shown and announced.
- "Why?" on a failed receipt is a disclosure button (`aria-expanded`, `aria-controls`) that opens
  the explanation inline, as a named region, not a dialog. Strengths are written as numbers as
  well as tally strokes.
- The replay scrubber is a native range input; its spoken value names the phase and what
  happened in it ("Spring 1901 movement results: 1 standoff").
- On a desktop the sidebar scrolls as a column of its own with the phase's main action pinned
  to its foot, so opening What if or a Why? never pushes the main action below the fold.
- Automated: `e2e/feel.spec.ts` runs an axe scan with the explanation open, and checks Skip
  (and where focus goes after it), Escape, reduced motion, the disclosure state and the scrubber's spoken value on desktop and phone.

## Manual pass (2026-11-10)

- axe-core 4.14 with the WCAG 2.0, 2.1 and 2.2 A and AA rules, in headless Chrome at 1440x900,
  390x844 and 320x800, on the sandbox in every state reachable from a fresh game (unit selected,
  support mode, an illegal-move message, the coast menu, results, a retreat phase, winter builds,
  zoomed in, the board text open, the How to play dialog) and on every trust page: no violations.
- By keyboard, scripted over the Chrome DevTools protocol: a full game turn (choose a unit, choose
  its destination, support, the coast menu, Escape, adjudicate, continue) with focus checked at
  each step, the dialog's focus trap, Escape and focus return, and the live region text.
- Contrast of text, focus rings and state colours, reflow at 320 px, text spacing and reduced
  motion.

## Known limitations

- The map itself is a picture to a screen reader. Its content is available as the board text and
  the order lists, and every order can be given from the choices, but a screen reader user does not
  get the geography (which provinces border which) except through the choices offered for the
  selected unit.
- On the map, which power owns a unit or province is shown by colour. Units have a tooltip naming
  their power, and the board text lists the same information in words.
- Province codes are 10 px at the default zoom on a phone and on a 1440x900 screen. On a short
  laptop screen (1280x720, 1366x768) the whole board is shown and the codes are about 8 px; one
  step of zoom brings them to 10 px and more.
- Arrow keys step through the phase history only when focus is on the board or the page, not on
  a button or link. The stepper above the results has Previous and Next buttons for the rest.
- A solo victory or draw is announced from the same code path as other results, but was checked by
  unit test rather than by playing a game to the end.

## Reporting a barrier

Open an issue at <https://github.com/KarthikSubramanian07/Cabal/issues> describing the page, what
you were trying to do and the assistive technology you use. Accessibility bugs are treated as bugs.

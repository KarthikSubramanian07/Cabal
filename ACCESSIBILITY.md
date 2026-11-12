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
- **Map controls.** Zoom has buttons, and once zoomed in, pan buttons replace dragging.

## How it was tested (2026-11-10)

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
- A solo victory or draw is announced from the same code path as other results, but was checked by
  unit test rather than by playing a game to the end.

## Reporting a barrier

Open an issue at <https://github.com/KarthikSubramanian07/Cabal/issues> describing the page, what
you were trying to do and the assistive technology you use. Accessibility bugs are treated as bugs.

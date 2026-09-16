# Brand

<img src="brand/wordmark.svg" alt="CABAL" width="320" />

The wordmark is a heavy grotesque with the second A turned over in vermilion: the member of the cabal who is not what they seem. The concept art lives in [`brand/`](brand/) and the web client renders the same shapes from traced SVG paths (`apps/web/src/Wordmark.tsx`), so it stays crisp at any size.

## Palette

| Token | Hex | Use |
|---|---|---|
| Ink | `#121110` | Text, the top bar, primary buttons, coastlines |
| Bone | `#F4F0E6` | Page background, wordmark on ink |
| Brass | `#C8A24A` | Active and selectable states, legal targets on the board |
| Vermilion | `#D94F30` | The turned A, failures, standoffs, the rule under the top bar |

The board keeps classic Diplomacy colours so players read it instantly: parchment land, sea blue, and one familiar hue per power (Austria red, England blue, France light blue, Germany grey, Italy green, Russia purple, Turkey yellow). Supply centre provinces take their owner's colour at 34 percent, occupied provinces at 17 percent.

## Type

- **Archivo Black** for the phase title and display text.
- **Inter Tight** for the interface.
- **IBM Plex Mono** for orders, province codes and anything the adjudicator writes.

## Rules of thumb

- The board is the product. Chrome stays quiet, flat and square cornered.
- Vermilion means something went wrong or someone was betrayed. Do not use it for decoration.
- No gradients, glass or glow. Depth comes from rules, borders and one soft shadow under the board.

# About Cabal

Cabal is an open-source project to put classic Diplomacy online with the same rules tournament players already trust, and with receipts agents and humans can both read. The adjudication core is written in Rust, compiled to WebAssembly, and checked against the full Diplomacy Adjudicator Test Cases (DATC) corpus. Nothing in Cabal changes how support is cut, how convoys work, or how civil disorder is resolved; the product layers sit above adjudication.

On playcabal.pages.dev you can play against six bots in under a minute, set a table for friends, watch public games, and play finished ones back phase by phase. Promises can be sealed in wax: the exact orders behind them, committed on your device and opened when the phase resolves, so the Ledger can show who kept their word. The sandbox draws the classic board from public-domain Natural Earth geography and lets you order all seven powers yourself, with a reason for every result. Optional secret cabals, vendettas and ghost votes for eliminated players are on the roadmap.

## Why it exists

Most browser Diplomacy clients bury the rules engine or treat negotiation as disposable chat. Cabal treats the adjudicator as the source of truth and builds negotiation features that can be verified after the phase resolves. That makes the game fairer for people and usable as a substrate for language-model players.

## Project status

Live games on Cloudflare Durable Objects, guest accounts, sealed pledges, ratings and the trust Ledger, the Rust bot and opt-in Claude seats, and the DATC-complete engine are live. Cabal is maintained by Karthik Subramanian and contributors under the MIT license.

## Links

- [Play](/)
- [The sandbox](/sandbox)
- [The Ledger](/ledger)
- [Contact](/contact)
- [Privacy](/privacy)
- [GitHub repository](https://github.com/KarthikSubramanian07/Cabal)
- [Architecture notes](https://github.com/KarthikSubramanian07/Cabal/blob/main/docs/ARCHITECTURE.md)

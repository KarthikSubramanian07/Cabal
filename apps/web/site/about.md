# About Cabal

Cabal is an open-source project to put classic Diplomacy online with the same rules tournament players already trust, and with receipts agents and humans can both read. The adjudication core is written in Rust, compiled to WebAssembly, and checked against the full Diplomacy Adjudicator Test Cases (DATC) corpus. Nothing in Cabal changes how support is cut, how convoys work, or how civil disorder is resolved; the product layers sit above adjudication.

The public sandbox on playcabal.pages.dev draws the classic board from public-domain Natural Earth geography, lets you compose orders by clicking provinces, and shows a reason for every order after you adjudicate. The wider Cabal design adds press with cryptographic pledges, a trust ledger across games, optional secret cabals, vendettas, ghost votes for eliminated players, and AI seats that speak the same protocol as humans.

## Why it exists

Most browser Diplomacy clients bury the rules engine or treat negotiation as disposable chat. Cabal treats the adjudicator as the source of truth and builds negotiation features that can be verified after the phase resolves. That makes the game fairer for people and usable as a substrate for language-model players.

## Project status

The sandbox and DATC-complete engine are live. Ranked multiplayer on Cloudflare Durable Objects, pledges, and agent seats are under active development in the public repository. Cabal is maintained by Karthik Subramanian and contributors under the MIT license.

## Links

- [Play the sandbox](/)
- [Contact](/contact)
- [Privacy](/privacy)
- [GitHub repository](https://github.com/KarthikSubramanian07/Cabal)
- [Architecture notes](https://github.com/KarthikSubramanian07/Cabal/blob/main/docs/ARCHITECTURE.md)

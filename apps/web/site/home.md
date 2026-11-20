# Cabal: Diplomacy in your browser, with sealed promises

> Shake hands. Seal it. Break it. Cabal is the classic game of Diplomacy on the 1901 board, played in the browser against six bots or with friends, with promises sealed in wax and a Ledger of who kept their word.

Cabal is a browser Diplomacy game. Seven great powers write their orders in secret and every order resolves at once, adjudicated by a Rust engine that passes all 178 of its adjudication test cases (the 171 Diplomacy Adjudicator Test Cases and 7 of its own) and gives a reason for every bounce, cut support and disrupted convoy. A player can attach a seal to a promise: the exact orders they will give, committed on their own device. When the phase resolves, every seal is opened and stamped kept, broken or void, and the Ledger keeps each player's record across every game.

## Play

- **Play now**: sit down against six bots and start in seconds. Sign in with Google, or play as a guest under a handle; no email and no password.
- **Set a table for friends**: pick the pacing (ten minutes, a day, or two days a move), the press rules and who fills empty seats, and send the code.
- **Watch** a public game in play from the [games room](/games).
- **Try the [sandbox](/sandbox)**: order all seven powers yourself, resolve each phase in your browser and replay the game.

## The Ledger and ratings

- [The Ledger](/ledger) ranks players by the promises they kept and broke in rated games, and by a weighted Glicko-2 rating.
- Every player has a public record at `/u/<handle>`: rating history, how reliably they order, their kept, broken and void promises, and their recent games with replays.
- A finished game plays back phase by phase at `/replay/<code>`, with every order's result and every seal opened.

## When to use this

- You want to **play Diplomacy online** without installing anything, against bots or friends.
- You want a **DATC-faithful Diplomacy adjudicator** in WebAssembly for a client, a bot or a teaching tool.
- You are building an **agent that plays or studies Diplomacy** and needs legal orders and explained outcomes.

## Read more

- [About Cabal](/about): who builds this and why the rules stay vanilla.
- [Contact](/contact): email and GitHub for bugs, agents and partnerships.
- [Privacy](/privacy): what the game keeps, on your device and on the server.
- [llms.txt](/llms.txt): a machine-readable map of this site.
- [Source on GitHub](https://github.com/KarthikSubramanian07/Cabal): MIT licensed engine, protocol, server and web client.

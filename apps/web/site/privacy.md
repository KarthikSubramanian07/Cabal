# Privacy at Cabal

This page describes what Cabal at playcabal.pages.dev keeps about you, where, and why. Cabal is an open-source Diplomacy game. It asks for no email, no password and no real name.

## On your own device

- **The sandbox** keeps your game in your browser's local storage so a reload does not lose it. It is never sent anywhere. The rules engine runs as WebAssembly in your browser; sandbox orders are not uploaded.
- **Your account**, once you choose a handle: its id, the handle, and a secret the server issued to this device. The secret proves the device is you; it is sent only as a request header to Cabal's own server, never in an address.
- **Your seats**: for each table you sit at, a seat token, kept the same way, with the handle you sat down under and the account that took it. Signing out of the device forgets the seats your account took here.
- **Notifications on this device**: which account turned them on here, so a device that changes hands does not report them on for the next person.
- Small preferences: whether single-key shortcuts are on, whether the table's sounds are on, the last name this device sat down under, and whether you said "Not now" to notifications.
- **The app itself**: the service worker keeps a copy of the site's own files (its scripts, styles, fonts, map and engine) so Cabal opens quickly and offline. It keeps no game data and nothing from Cabal's server.

Clearing this site's data in your browser removes all of it. Without a recovery code, an account whose last device is cleared cannot be recovered.

## On Cabal's server

- **Your account**: a random id, your handle (and, for a while, a handle you gave up, so old links still work), when the account was made and last used, and for each signed-in device only a SHA-256 hash of its secret. A recovery code is stored only as a hash too.
- **Your games**: the tables you sit at, the orders, press and sealed pledges you send in them, the results, and, for finished games, your record: rating, how reliably you ordered, and the promises you kept and broke. Records, ratings and the Ledger are public, under your handle. The orders under a seal are readable by the server, so a seal protects you from the other players, not from the server; every seal is opened to its audience when its phase resolves, and to everyone once the game is over.
- **Notifications**, only if you turn them on: the address your browser's push service gave this device and the keys messages to it are encrypted with, and which kinds you want. Messages say what happened and where; never the text of press or anyone's orders.
- **Measurements**: counts and timings with no player, address or device attached. While you play, your browser times how long each set of orders takes to reach the server and come back, and, on a visit that starts at the front page, how long it took to reach a game in progress. When you leave or hide the page it sends those numbers, and nothing else, in one message; the server keeps only daily totals for each continent (Cloudflare tells it which one the message came from), never the message itself.

The server runs on Cloudflare Workers, Durable Objects and D1. Cloudflare processes ordinary request logs (address, browser, time) to operate the service.

## Leaving

Sign out of a device from the player menu to end its session; its notifications stop with it.

To leave for good, open the account card from the player menu (Rename, Recovery code and Sign out all open it), choose **Delete this account** at its foot and type your handle to confirm. It takes effect at once and cannot be undone:

- Your account goes from the server: the handle (free for anyone to take), every device session, the recovery code, your rating and its history, your reliability and Ledger totals, your notification switches and every push subscription.
- Your seats become ghosts. In a lobby the seat opens again. In a running game it falls into civil disorder, as if you had walked away: it is open to a substitute, and the bot holds it where the table asked for AI seats. Finished games keep their results and their orders, under the name "Ghost" instead of yours.
- Other players keep what their games gave them. Their ratings moved against yours, and those moves stay, but the record of whom they played no longer points to you.
- Press you sent stays in each game, signed by the power you played (never by your handle), because the players you sent it to and the receipts that judged your pledges rely on it.

This device then forgets the account, its seats and its notifications. Cloudflare's ordinary request logs age out on their own schedule.

## Contact

Privacy questions: open an issue on [GitHub](https://github.com/KarthikSubramanian07/Cabal/issues). Say it is private and the maintainer will follow up through a private channel.

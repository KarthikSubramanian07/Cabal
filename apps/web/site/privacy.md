# Privacy at Cabal

This page describes what Cabal at playcabal.pages.dev keeps about you, where, and why. Cabal is an open-source Diplomacy game. It asks for no email, no password and no real name: you sign in with Google, which hands Cabal only a mark that it is you, or play as a guest under a handle.

## On your own device

- **The sandbox** keeps your game in your browser's local storage so a reload does not lose it. The rules engine runs as WebAssembly in your browser. Signed out, the game never leaves this device; signed in, a copy goes to your account (see below) so your other devices open on it.
- **Your account**, once you sign in or choose a handle: its id, the handle, whether it signs in with Google, and a secret the server issued to this device. The secret proves the device is you; it is sent only as a request header to Cabal's own server, never in an address.
- **Your seats**: for each table you sit at, a seat token, kept the same way, with the handle you sat down under and the account that took it. Signing out of the device forgets the seats your account took here.
- **Notifications on this device**: which account turned them on here, so a device that changes hands does not report them on for the next person.
- Small preferences: whether single-key shortcuts are on, whether the table's sounds are on, the last name this device sat down under, and whether you said "Not now" to notifications.
- **The app itself**: the service worker keeps a copy of the site's own files (its scripts, styles, fonts, map and engine) so Cabal opens quickly and offline. It keeps no game data and nothing from Cabal's server.

Clearing this site's data in your browser removes all of it. An account that signs in with Google comes back with Google; a guest account whose last device is cleared comes back only with its recovery code.

## On Cabal's server

- **Your account**: a random id, your handle (and, for a while, a handle you gave up, so old links still work), when the account was made and last used, and for each signed-in device only a SHA-256 hash of its secret. A recovery code is stored only as a hash too.
- **Sign in with Google**, if you use it: only a SHA-256 hash of the id Google gives your Google account, so the same Google account opens the same Cabal account. The signed note Google's button hands back also carries your email address and name; the server checks Google's signature, reads only the id, and keeps none of the rest. Google's button and its sign-in window are Google's own, under Google's privacy policy. You can unlink Google from the account card at any time; deleting the account deletes the link.
- **What follows you between devices**, while you are signed in: whether shortcuts and sounds are on, and your sandbox game (its moves and the orders you were writing), each with the time it was saved, so the newest copy wins. Starting a new sandbox game deletes the old copy.
- **Your games**: the tables you sit at, the orders, press and sealed pledges you send in them, the results, and, for finished games, your record: rating, how reliably you ordered, and the promises you kept and broke. Records, ratings and the Ledger are public, under your handle. The orders under a seal are readable by the server, so a seal protects you from the other players, not from the server; every seal is opened to its audience when its phase resolves, and to everyone once the game is over.
- **Notifications**, only if you turn them on: the address your browser's push service gave this device and the keys messages to it are encrypted with, and which kinds you want. Messages say what happened and where; never the text of press or anyone's orders.
- **Reports**, if you report a player from their record: who sent it, about whom, why, your note and when, read only by the maintainers. The player is not told who sent it.
- **New accounts per network address**: to spot one person making many accounts, the server counts the accounts made each day under a keyed hash (HMAC-SHA-256) of the day and your address. The key is a server secret kept apart from the database, so the stored value cannot be turned back into an address by trying them all. It never stores the address, the count changes key every day, and it is deleted after two days.
- **Measurements**: counts and timings with no player, address or device attached. While you play, your browser times how long each set of orders takes to reach the server and come back, and, on a visit that starts at the front page, how long it took to reach a game in progress. When you leave or hide the page it sends those numbers, and nothing else, in one message; the server keeps only daily totals for each continent (Cloudflare tells it which one the message came from), never the message itself.

- **Error reports**: when a page breaks, your browser tells the server what broke: the error's message, which kind of page it was (a game, the Ledger) but not its address, and the line of Cabal's code where it happened. Nothing names you or this device: a table's code or a handle the message happens to quote, yours among them, is masked before it leaves your browser and again on the server. The server writes it into its own logs with the continent it came from, keeps nothing else, and a page sends at most five a visit.

The server runs on Cloudflare Workers, Durable Objects and D1. Cloudflare processes ordinary request logs (address, browser, time) to operate the service.

## Leaving

Sign out from the player menu to end this device's session; its notifications stop with it, and an account that signs in with Google also takes its sandbox game off the device. The account card can sign out every device at once.

To leave for good, open the account card from the player menu (Rename, Recovery code and Sign out all open it), choose **Delete this account** at its foot and type your handle to confirm. It takes effect at once and cannot be undone:

- Your account goes from the server, with its link to a Google account if it had one: the handle (free for anyone to take an hour later, so no game can link your old seat to a newcomer under the same name), every device session, the recovery code, your rating and its history, your reliability and Ledger totals, your notification switches, every push subscription, and the settings and sandbox game kept for your other devices.
- Your seats become ghosts. In a lobby the seat opens again. In a running game it falls into civil disorder, as if you had walked away: it is open to a substitute, and the bot holds it where the table asked for AI seats. Finished games keep their results and their orders, under the name "Ghost" instead of yours.
- Other players keep what their games gave them. Their ratings moved against yours, and those moves stay, but the record of whom they played no longer points to you.
- Press you sent stays in each game, signed by the power you played (never by your handle), because the players you sent it to and the receipts that judged your pledges rely on it.

This device then forgets the account, its seats and its notifications. Cloudflare's ordinary request logs age out on their own schedule.

## Contact

Privacy questions: open an issue on [GitHub](https://github.com/KarthikSubramanian07/Cabal/issues). Say it is private and the maintainer will follow up through a private channel.

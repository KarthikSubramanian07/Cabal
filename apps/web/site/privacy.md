# Privacy at Cabal

This page describes what Cabal at playcabal.pages.dev keeps about you, where, and why. Cabal is an open-source Diplomacy game. It asks for no email, no password and no real name.

## On your own device

- **The sandbox** keeps your game in your browser's local storage so a reload does not lose it. It is never sent anywhere. The rules engine runs as WebAssembly in your browser; sandbox orders are not uploaded.
- **Your account**, once you choose a handle: its id, the handle, and a secret the server issued to this device. The secret proves the device is you; it is sent only as a request header to Cabal's own server, never in an address.
- **Your seats**: for each table you sit at, a seat token, kept the same way.
- Small preferences: whether single-key shortcuts are on, and whether you said "Not now" to notifications.

Clearing this site's data in your browser removes all of it. Without a recovery code, an account whose last device is cleared cannot be recovered.

## On Cabal's server

- **Your account**: a random id, your handle (and, for a while, a handle you gave up, so old links still work), when the account was made and last used, and for each signed-in device only a SHA-256 hash of its secret. A recovery code is stored only as a hash too.
- **Your games**: the tables you sit at, the orders, press and sealed pledges you send in them, the results, and, for finished games, your record: rating, how reliably you ordered, and the promises you kept and broke. Records, ratings and the Ledger are public, under your handle. The orders under a seal are readable by the server, so a seal protects you from the other players, not from the server; every seal is opened to its audience when its phase resolves, and to everyone once the game is over.
- **Notifications**, only if you turn them on: the address your browser's push service gave this device and the keys messages to it are encrypted with, and which kinds you want. Messages say what happened and where; never the text of press or anyone's orders.
- **Measurements**: counts and timings with no player, address or device attached.

The server runs on Cloudflare Workers, Durable Objects and D1. Cloudflare processes ordinary request logs (address, browser, time) to operate the service.

## Leaving

Sign out of a device from the player menu to end its session; its notifications stop with it. To have an account and its record removed, open an issue as below with your handle and the maintainer will follow up privately.

## Contact

Privacy questions: open an issue on [GitHub](https://github.com/KarthikSubramanian07/Cabal/issues). Say it is private and the maintainer will follow up through a private channel.

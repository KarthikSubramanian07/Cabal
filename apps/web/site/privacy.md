# Privacy at Cabal

This page describes how the Cabal sandbox at playcabal.pages.dev handles information today. Cabal is an open-source Diplomacy game client. The sandbox is designed to keep play in your browser whenever possible.

## What the sandbox processes

- Game state for the classic Diplomacy board, including unit positions, supply-center ownership, and the orders you enter, is held in your browser. So that a reload does not lose your game, the sandbox also saves it in your browser's local storage on your own device. It stays there until you start a new game or clear your browser's site data, and it is never sent anywhere. A save file is only written when you choose to export one.
- The Rust adjudication engine runs as WebAssembly inside your browser. Orders are not uploaded to a Cabal server for the sandbox flow.
- Static assets (scripts, styles, fonts, map data) are served from Cloudflare Pages. Cloudflare may process standard request logs such as IP address, user agent, and timestamps as part of operating the CDN.
- If you email the maintainer or open a GitHub issue, GitHub or your mail provider processes that correspondence under their own terms.

## Cookies and accounts

The current sandbox does not require an account and does not set authentication cookies. We do not run third-party advertising trackers on the sandbox pages. Browser storage is used for two things, both of which stay on your device: the saved sandbox game described above, and your choice of whether single-key shortcuts are on. Your browser may also cache static assets in the ordinary way.

## Multiplayer roadmap

Future ranked multiplayer games will need server-side storage for rooms, press, and pledges. When those features ship, this privacy page will be updated before those flows ask for personal data. Until then, treat the sandbox as a local client with CDN delivery only.

## Contact

Privacy questions: open an issue on [GitHub](https://github.com/KarthikSubramanian07/Cabal/issues). Say it is private and the maintainer will follow up through a private channel.

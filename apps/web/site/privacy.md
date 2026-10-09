# Privacy at Cabal

This page describes how the Cabal sandbox at playcabal.pages.dev handles information today. Cabal is an open-source Diplomacy game client. The sandbox is designed to keep play in your browser whenever possible.

## What the sandbox processes

- Game state for the classic Diplomacy board, including unit positions, supply-center ownership, and the orders you enter, is held in memory in your browser and in any save file you choose to download.
- The Rust adjudication engine runs as WebAssembly inside your browser. Orders are not uploaded to a Cabal server for the sandbox flow.
- Static assets (scripts, styles, fonts, map data) are served from Cloudflare Pages. Cloudflare may process standard request logs such as IP address, user agent, and timestamps as part of operating the CDN.
- If you email the maintainer or open a GitHub issue, GitHub or your mail provider processes that correspondence under their own terms.

## Cookies and accounts

The current sandbox does not require an account and does not set authentication cookies. We do not run third-party advertising trackers on the sandbox pages. Browser storage may be used for ordinary caching of static assets by Cloudflare or your browser.

## Multiplayer roadmap

Future ranked multiplayer games will need server-side storage for rooms, press, and pledges. When those features ship, this privacy page will be updated before those flows ask for personal data. Until then, treat the sandbox as a local client with CDN delivery only.

## Contact

Privacy questions: open an issue on [GitHub](https://github.com/KarthikSubramanian07/Cabal/issues). Say it is private and the maintainer will follow up through a private channel.

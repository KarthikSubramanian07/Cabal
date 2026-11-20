# Integrations: Discord, email and Slack

Issue [#12](https://github.com/KarthikSubramanian07/Cabal/issues/12) ends with bridges that let players get and answer press where they already are. None of them is built yet, because each one needs something only the owner can give: an account, a secret, a domain or a paid plan. This page lists exactly what each one needs, so that work can start the day it is given.

The rules every bridge follows are already decided and do not change here:

- Press stays inside Cabal. A seal and its receipt need the server to see the message and the pledge together, so the pledge interface stays in the app and a bridge only carries ordinary press.
- A bridge uses the same public HTTP and WebSocket protocol as the web app (`@cabal/protocol`). There are no private server paths for bridges.
- Every bridged message is stored as ordinary press, so receipts and the Ledger are unaffected.
- Web Push already covers phones (`apps/server/src/push.ts`, VAPID). iMessage is out: Apple has no public API, and the bridges that run on a Mac are unreliable and against Apple's terms.

## What is needed from the owner

| Bridge | Costs money | What the owner provides | Where it goes |
|---|---|---|---|
| Discord | No | A Discord application with a bot user; its application id, public key and bot token; a test server to install it in | `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` as plain variables, `DISCORD_BOT_TOKEN` as a Worker secret |
| Email | Yes | A domain on Cloudflare, and the Workers Paid plan | A `send_email` binding and an Email Routing rule in `apps/server/wrangler.jsonc` |
| Slack | No | A Slack app with a bot token and signing secret; a test workspace | `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` as Worker secrets |

Secrets are set with `pnpm --filter @cabal/server exec wrangler secret put <NAME>` by whoever deploys (see the runbook in [CONTRIBUTING.md](../CONTRIBUTING.md#deploying)); they never go into the repository or into CI.

## Discord

Free. Discord is the first bridge because Cabal's players already organise games there.

**The owner does this once:**

1. Create an application at the Discord Developer Portal, add a bot user, and copy the **application id**, the **public key** (General Information) and the **bot token** (Bot, Reset Token).
2. Set the **Interactions Endpoint URL** to `https://cabal-server.karthik-e5e.workers.dev/api/integrations/discord` once that route is deployed. Discord sends a signed ping to the URL and refuses to save it unless the Worker answers, so this step comes after the first deploy of the bridge.
3. Install the bot in a test server with the `bot` and `applications.commands` scopes and the Send Messages permission, and say which channel is for testing.
4. Give the three values to whoever deploys: the bot token through `wrangler secret put DISCORD_BOT_TOKEN`, the other two as plain variables.

**What gets built with them:**

- `POST /api/integrations/discord`: every interaction is checked against `DISCORD_PUBLIC_KEY` (Ed25519, with Web Crypto, no dependency) before anything else, and refused with 401 otherwise.
- Slash commands `/orders`, `/ready` and `/deadline`, registered once with the application id and bot token. A player links a seat by running `/cabal link` and confirming in the app, which stores the Discord user id against the signed-in player (one new D1 table, added in a migration of its own; nothing existing changes).
- Deadline reminders, phase results and receipts posted to a linked channel; a DM when press arrives; a DM reply sent back into the game as press from that seat.
- Tests: workerd tests with a fake Discord API (no network), a signature test with a fixed key pair, and a bot account playing a phase through Discord only.

## Email

**Costs money.** Two things block it, and both are the owner's call:

- **A domain on Cloudflare.** Email can only be sent from a domain onboarded to Cloudflare Email Service. `playcabal.pages.dev` and `workers.dev` belong to Cloudflare and cannot be onboarded, so Cabal needs a domain of its own (for example `playcabal.com`) added to the account as a zone. That domain also gives the site a cleaner address than `pages.dev`.
- **The Workers Paid plan.** Sending to anyone other than the account's own verified addresses needs it: about 5 US dollars a month, with 3,000 emails a month included and then 0.35 US dollars per 1,000 (Cloudflare's pricing page, checked 2026-11-19). Receiving mail with Email Routing is free on every plan.

**Once both exist, the owner does this once:**

1. Run `pnpm --filter @cabal/server exec wrangler email sending enable <domain>` and add the SPF, DKIM and DMARC records it prints (Cloudflare adds them itself when the domain's DNS is on Cloudflare).
2. Run `pnpm --filter @cabal/server exec wrangler email routing enable <domain>` and route an address such as `press@<domain>` to the `cabal-server` Worker.

**What gets built with them:**

- A `send_email` binding (`EMAIL`) in `apps/server/wrangler.jsonc`, with no API key: deadline reminders and a press digest for players who turn email on (an address kept only for that, deletable like everything else on the privacy page).
- An `email()` handler on the Worker for replies: each digest's reply-to address carries a one-time token for one seat in one game, the reply is parsed (`postal-mime`) and its first paragraph becomes press from that seat.
- Magic-link sign-in reusing the same sender, as a second way back into an account beside the recovery code.
- Tests: an email round trip with a fixture message through the `email()` handler, and the send binding faked in workerd.

## Slack

Free, and the same shape as Discord (a signed request endpoint plus a bot). It waits until the Discord bridge has run real games, so that one bridge's design is settled before a second copies it.

**The owner does this once:** create a Slack app, add a bot with `chat:write` and `im:history`, install it in a test workspace, and give the **signing secret** and the **bot token** to whoever deploys, as Worker secrets. The request URL is `https://cabal-server.karthik-e5e.workers.dev/api/integrations/slack`, set after the route is deployed, for the same reason as Discord's.

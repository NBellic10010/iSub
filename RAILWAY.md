# Deploy iSub to Railway

Two services from this one repo (npm-workspace monorepo): the **web** app (Next.js dashboards +
checkout) and the **gateway** (off-chain index + `/usage` `/charges` `/report`). Both build cleanly
(verified: `next build` ✓, gateway runs on Node 22 ✓).

## What is / isn't hosted (honest)
- ✅ **Hosted = the browser/human half**: connect wallet (testnet) → subscribe via `/checkout` or
  `/merchant`, see dashboards, non-custodial **pause/revoke/withdraw**, export the compliance CSV.
  Works great on a real Railway HTTPS domain (better than localhost — real cert, wallet pops normally).
- ⚠️ **Agent scenes (Claude CLI + keeper) are local CLI — not hosted.** A hosted web+gateway can't run
  the Claude CLI agent or the keeper. Charging options below.

## Prereq
This repo is pushed to `github.com/NBellic10010/iSub`. Use either path:
- **A — Railway UI (recommended, no CLI):** New Project → Deploy from GitHub → pick the repo → add the
  two services below.
- **B — CLI:** `npm i -g @railway/cli && railway login && railway up` (needs your interactive login).

## Service 1 — gateway  (deploy FIRST, to get its URL)
- Builder: **Dockerfile**, path `Dockerfile.gateway`
- Variables: `ISUB_NETWORK=testnet`  (Railway injects `PORT` automatically)
- Networking: enable a public domain → e.g. `https://isub-gateway-xxxx.up.railway.app`
- (Optional) **Volume** mounted at `/app/sdk` + var `ISUB_INDEX_DB=/app/sdk/isub-index.testnet.db` so
  the index/charges survive redeploys. Without it, the index is ephemeral and repopulates as users
  subscribe (each subscribe re-ingests its mandate).

## Service 2 — web
- Builder: **Dockerfile**, path `Dockerfile.web`
- Variables: `GATEWAY_ORIGIN=https://isub-gateway-xxxx.up.railway.app`  ← paste service-1's URL
  - (the web calls the gateway through its same-origin `/gw` proxy; `next.config.ts` forwards `/gw/*`
    to `GATEWAY_ORIGIN` server-side, so no mixed-content / CORS, and the gateway's real Railway cert is
    trusted — unlike the self-signed localhost case.)
  - Leave `NEXT_PUBLIC_GATEWAY_URL` UNSET (defaults to `/gw`).
- Public domain → e.g. `https://isub-web-xxxx.up.railway.app` — this is the demo URL.

Deploy order: **gateway → copy its URL into web's `GATEWAY_ORIGIN` → deploy web.**

## Charging on a hosted demo (the keeper/agent half)
The hosted app handles **authorization** (wallet signs mandates). Pulling the actual charges needs a
keeper/biller, which is NOT hosted by default. Pick one:
1. **Local (simplest for a video):** run `npm run keeper -- <mandateId>` / `npm run bill -- <mandateId>`
   / `npm run isub:claude:testnet` **on your machine** against the *hosted* mandates. They're on the
   same testnet, so a local keeper charges a mandate a judge created on the hosted site.
2. **Hosted keeper worker (optional 3rd service):** a Railway service running `npm run keeper:testnet`
   with the **keeper actor key as a Railway SECRET env** (never committed). More setup; only needed for
   fully-hands-off cloud charging.

## Secrets — confirmed safe
`.dockerignore` excludes `.secrets/`, `sdk/scripts/.x402-testnet.json`, `.token-agent.json`, `*.db`,
`.keeper/`, `web/.env.local`. None of these ship in the image. The gateway auto-generates a throwaway
`gateway-keeper` key on boot (it never charges, so this is harmless).

## Merchant demo sites (AfterDark / CityGrid / Cortex) — optional
These live in `checkout/` (Vite). For a hosted demo, deploy a 3rd static service AND point each page's
checkout at the deployed web (pass `checkoutUrl: 'https://isub-web-xxxx.up.railway.app/checkout'` to
`iSubCheckout.open`, since the loader defaults to `https://localhost:3000/checkout`). For judging, the
hosted web's own `/checkout` + `/merchant` already cover the subscribe flow — the branded sites are a
nicety best shown from the local `npm run dev` during the video.

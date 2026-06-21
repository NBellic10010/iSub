# Deploy iSub to Railway

Two services from this one repo (npm-workspace monorepo): the **web** app (Next.js dashboards +
checkout) and the **backend** (gateway HTTP + FIXED keeper + PAYG auto-bill, one process / one sqlite).
Both build & run cleanly (verified: `next build` ✓, backend charges real testnet mandates ✓).

## What runs in the cloud
- ✅ **Subscribe / cancel** — wallet signs/revokes on-chain via the web app (real HTTPS domain → wallet
  pops normally). Cancel = revoke; the backend stops billing a revoked mandate automatically.
- ✅ **Billing (FIXED + PAYG)** — the **backend** auto-discovers Active mandates from the index (ingested
  on subscribe) and charges them: **FIXED** on its interval (keeper), **PAYG** via a periodic auto-bill
  (simulated metered usage). Charges show on the dashboard chart + `/report`.
- ⚠️ **Only for OUR demo plans** (`authorized_keeper` = the keeper key you provide). A judge who creates
  their OWN plan at `/merchant` (keeper = their wallet) won't be auto-charged by this backend — that's
  the contract's keeper-authorization design, not a bug.
- ⚠️ **PAYG auto-bill is a simulated usage loop** (no hosted agent generates real calls). It's labelled
  as such; the mechanism (charge_metered within the signed cap) is 100% real on-chain.

## Prereq
Repo is at `github.com/NBellic10010/iSub`. Deploy via **Railway UI** (New Project → Deploy from GitHub →
add the two services) or **CLI** (`npm i -g @railway/cli && railway login && railway up`).

## Service 1 — backend  (deploy FIRST, to get its URL)
- Builder: **Dockerfile**, path `Dockerfile.backend`
- Variables: `ISUB_NETWORK=testnet`  (Railway injects `PORT`)
- **SECRET** `ISUB_KEEPER_KEY` = the bech32 `suiprivkey…` of the plans' authorized keeper (your
  `.secrets/testnet/keeper.key`). **Required for cloud billing**; never commit it. Add it as a Railway
  *sealed* variable.
- The keeper must be **funded with testnet gas** (it signs every charge): faucet its address.
- (Recommended) **Volume** mounted at `/app/sdk` + var `ISUB_INDEX_DB=/app/sdk/isub-index.testnet.db` so
  the index + charge history survive redeploys. Without it they're ephemeral (repopulate as users act).
- (Optional tuning) `ISUB_PAYG_TICK_MS` (default 15000), `ISUB_PAYG_AMOUNT` (default 2000000 = 0.002 SUI).
- Enable a public domain → e.g. `https://isub-backend-xxxx.up.railway.app`.

> Read-only alternative: if you do NOT want a keeper key in the cloud, deploy `Dockerfile.gateway`
> instead (gateway only — no billing) and run `keeper`/`bill` locally against the hosted mandates.

## Service 2 — web
- Builder: **Dockerfile**, path `Dockerfile.web`
- Variables: `GATEWAY_ORIGIN=https://isub-backend-xxxx.up.railway.app`  ← paste service-1's URL
  - the web calls it through its same-origin `/gw` proxy (`next.config.ts` forwards `/gw/*` →
    `GATEWAY_ORIGIN` server-side: no mixed-content / CORS, and the backend's real Railway cert is trusted).
  - leave `NEXT_PUBLIC_GATEWAY_URL` UNSET (defaults to `/gw`).
- Public domain → e.g. `https://isub-web-xxxx.up.railway.app` — **the demo URL**.

Deploy order: **backend → copy its URL into web's `GATEWAY_ORIGIN` → deploy web.**

## End-to-end flow on the hosted site
1. Judge opens the web URL → connects wallet (testnet) → **Deposit** into their account.
2. Subscribes (via `/checkout`, `/merchant`, or a branded merchant site) → wallet signs a mandate →
   checkout ingests it → the backend discovers it within ~10s.
3. **FIXED** → keeper charges on interval (card `spent` rises + chart bar). **PAYG** → auto-bill charges
   every `ISUB_PAYG_TICK_MS` (chart bars + spent).
4. **Pause / Revoke / Withdraw** on the dashboard → backend stops billing; funds return to the wallet.
5. **Export compliance CSV** → the month's charges with on-chain digests.

## Secrets — confirmed safe
`.dockerignore` excludes `.secrets/`, `sdk/scripts/.x402-testnet.json`, `.token-agent.json`, `*.db`,
`.keeper/`, `web/.env.local` — none ship in the image. The ONLY secret you add is `ISUB_KEEPER_KEY`, as a
Railway sealed variable (not in git).

## Merchant demo sites (AfterDark / CityGrid / Cortex) — optional 3rd service
In `checkout/` (Vite). To host: a 3rd static service, and point each page's checkout at the deployed web
(`iSubCheckout.open({ …, checkoutUrl: 'https://isub-web-xxxx.up.railway.app/checkout' })`, since the
loader defaults to localhost). For judging, the hosted web's own `/checkout` + `/merchant` already cover
the subscribe flow.

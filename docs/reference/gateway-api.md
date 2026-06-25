# Gateway HTTP API

The routes served by `IsubGateway` (`@isubpay/sdk/gateway`). Two access tiers:

* **api-key** routes (header `x-isub-api-key: sk_…`) — a merchant's managed billing path.
* **public, address-keyed** routes — on-chain-public relationship/usage data for wallets (no key). All responses include permissive CORS; `OPTIONS` returns `204`.

u64 values cross the wire as **decimal strings** (JSON has no bigint).

## Health

```
GET /health → { "ok": true }
```

## Metered billing (api-key)

```
POST /usage           { mandateId, amount, usageId }   → 200 served · 402 gated · 403 bad key
POST /usage-metered   { mandateId, meterKey, qty, usageId }   (priced by the tenant RateCard)
GET  /subscriptions/:mandateId   → { serviceable, … }
```

Use the thin client instead of calling these by hand:

```typescript
import { IsubServiceClient } from '@isubpay/sdk/client';
const backend = new IsubServiceClient({ baseUrl, apiKey });
await backend.use(mandateId, 10_000_000n, 'req-1'); // → { ok, status }
await backend.status(mandateId);                     // → { serviceable, … } | null
```

`use()` records usage idempotently (by `usageId`); the gateway settles on-chain per its policy (the keeper signs). When budget/rate is exhausted it returns **402** — stop serving, no chain call in the hot path.

## Relationship index — write-time ingest

api-key (re-derives the row from a chain point-read, then upserts):

```
POST /index/plan      { planId }
POST /index/mandate   { mandateId }
```

Public ingest (same re-derivation, no key — used by the wallet flow / checkout):

```
POST /relations/plan      { planId }
POST /relations/mandate   { mandateId }
POST /relations/account   { accountId }
```

## Relationship index — reads

api-key (scoped to your address):

```
GET /plans       → PlanRowJson[]
GET /mandates    → MandateRowJson[]
```

Public, address-keyed (on-chain-public data):

```
GET /relations/plans?merchant=0x…
GET /relations/mandates?subscriber=0x…   (cross-merchant)
GET /relations/mandates?plan=0x…
GET /relations/mandates?merchant=0x…
GET /relations/accounts?owner=0x…
```

These power the dashboards' discovery — e.g. `mandatesBySubscriber` is what lets a wallet find its mandates across merchants.

## Per-mandate usage & charges (public)

```
GET /usage?mandateId=0x…     → UsagePointJson[]    ({ usageId, amount, atMs, meterKey, qty, rateCardVersion, billed })
GET /charges?mandateId=0x…   → ChargePointJson[]   (kind='charged': { amount, seq, digest, atMs })
```

These are exactly what the dashboard's usage chart and wallet-usage rollup read. They serve from the gateway's SQLite db — so the **biller must write to the same db** (`ISUB_INDEX_DB=isub-index.<network>.db`, the default for `biller-run`).

## Web client

`web/lib/gateway.ts` wraps all of the above (`webGateway()` → `GATEWAY_URL` from `NEXT_PUBLIC_GATEWAY_URL`, default `http://localhost:4000`). Methods: `plansByMerchant`, `mandatesBySubscriber`, `mandatesByPlan`, `accountsByOwner`, `usage`, `charges`, `ingestPlan/ingestMandate/ingestAccount`.

> **Port match.** The web app reads `NEXT_PUBLIC_GATEWAY_URL`; run the gateway on that port (`PORT=… npm run gateway:serve`). A mismatch shows empty usage views even though the data exists.

## Running it

```bash
cd sdk
npm run gateway:serve            # localnet, :4000, db isub-index.localnet.db
npm run gateway-serve:testnet    # testnet
# overrides: PORT=4100 ISUB_INDEX_DB=isub-index.testnet.db npm run gateway-serve:testnet
```

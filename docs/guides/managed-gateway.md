# Managed gateway & index

The **gateway** lets a merchant integrate iSub **without self-hosting a keeper, a database, or any charge-signing**. Your backend talks to it over HTTP with an api-key; the gateway holds the keeper key and settles on the real chain.

```
your backend ──api-key HTTP──▶ IsubGateway ──keeper signs──▶ chain ──pay──▶ your payout address
   (record usage,                (charges, webhooks,           (charge_metered)
    check status)                 relationship index)
```

## Run a gateway (operator side)

```typescript
import { IsubGateway } from '@isubpay/sdk/gateway';
import { openDb } from '@isubpay/sdk/db';
import { registerMerchant } from '@isubpay/sdk/sql-store';

const db = openDb('isub-index.testnet.db');
registerMerchant(db, { id: 'acme', name: 'Acme Cloud', apiKey: 'sk_…', payoutAddress: merchant.address });

const gateway = new IsubGateway({
  chain: isub,
  keeperSigner,                    // signs charge_metered for tenant plans whose keeper = this address
  db,
  policy: { windowMs: 3_600_000 }, // settle cadence / batching policy
  routing: (merchantId) => merchantId === 'acme'
    ? { payoutAddress: merchant.address, webhook: { url: 'https://acme.example/wh', secret: 'whsec_…' } }
    : null,
});
gateway.listen(4000);
```

The repo ships this as `npm run gateway:serve` / `gateway-serve:testnet` (`PORT`, `ISUB_INDEX_DB` env). It also stands up the [relationship index](#relationship-index) used by the dashboards.

## Thin client (merchant side)

Your backend never imports `IsubClient`, a biller, a DB, or a signer — just the thin client:

```typescript
import { IsubServiceClient, verifyWebhook } from '@isubpay/sdk/client';

const backend = new IsubServiceClient({ baseUrl: 'https://gateway…', apiKey: 'sk_…' });

// meter a unit of usage — returns 200 served / 402 gated / 403 bad credential
const r = await backend.use(mandateId, 10_000_000n, 'req-1');
if (r.status === 402) return deny('out of budget');

// check serviceability
const st = await backend.status(mandateId);   // { serviceable, … } | null
```

`use()` records usage idempotently (by `usageId`) and the gateway settles it on-chain per its policy. When the budget/rate is exhausted, `use()` returns **402** — your service simply stops serving; no chain call needed in the hot path.

## Webhooks

The gateway delivers signed events (e.g. `charge.succeeded`) to your `webhook.url`. Verify them:

```typescript
import { verifyWebhook } from '@isubpay/sdk/client';

app.post('/wh', (req, res) => {
  const ok = verifyWebhook({ secret: 'whsec_…', body: rawBody, signatureHeader: req.headers['isub-signature'] });
  res.status(ok ? 200 : 401).end();
});
```

## Relationship index

gRPC can't enumerate **shared** objects by owner, so the gateway maintains an off-chain index (`IsubIndex`, `@isubpay/sdk/relations`) capturing relationships at write time and re-deriving each row from a chain point-read:

* `merchant → plans`, `subscriber → mandates` (cross-merchant), `plan → mandates`, `owner → accounts`
* per-mandate `usage` and `charges` series (what the dashboard's usage chart reads)

It's a **read-only projection** — the keeper/biller never read it on the hot path. Public, address-keyed routes serve on-chain-public data to wallets without an api-key. See the full route list in the [Gateway HTTP API](../reference/gateway-api.md).

> The biller and the gateway should share **one** SQLite file so charges land where the dashboard reads them. Point `biller-run` at the gateway's db with `ISUB_INDEX_DB=isub-index.<network>.db` (this is the default), and run the gateway on the port your web app's `NEXT_PUBLIC_GATEWAY_URL` expects.

## Acceptance test

`npm run managed-e2e` (or `:testnet`) is the executable spec: a merchant backend using **only** `@isubpay/sdk/client` (api-key + `use` + `verifyWebhook`), an agent that subscribes, the gateway settling on the real chain into the merchant's payout — with the merchant section touching no `IsubService`/biller/DB/signing at all.

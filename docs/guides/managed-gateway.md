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
    // agentAuthMode:'off' — trusted backend self-metering its own users (api-key is the trust
    // boundary). OMIT it and the tenant is secure-by-default 'enforce' (see "Auth posture" below).
    ? { payoutAddress: merchant.address, agentAuthMode: 'off', webhook: { url: 'https://acme.example/wh', secret: 'whsec_…' } }
    : null,
});
gateway.listen(4000);
```

The repo ships this as `npm run gateway:serve` / `gateway-serve:testnet` (`PORT`, `ISUB_INDEX_DB` env). It also stands up the [relationship index](#relationship-index) used by the dashboards.

## Thin client (merchant side)

Your backend never imports `IsubClient`, a biller, a DB, or a signer — just the thin client.
The proofless `use()` below assumes this tenant set `agentAuthMode:'off'` (as in the config above) —
on a secure-by-default `'enforce'` tenant you must pass a 4th `proof` arg. See [Auth posture](#auth-posture-secure-by-default).

```typescript
import { IsubServiceClient, verifyWebhook } from '@isubpay/sdk/client';

const backend = new IsubServiceClient({ baseUrl: 'https://gateway…', apiKey: 'sk_…' });

// meter a unit of usage — returns 200 served / 402 gated / 403 missing-or-invalid proof.
// (no `proof` arg ⇒ requires this tenant to be agentAuthMode:'off' — see Auth posture below)
const r = await backend.use(mandateId, 10_000_000n, 'req-1');
if (r.status === 402) return deny('out of budget');

// check serviceability
const st = await backend.status(mandateId);   // { serviceable, … } | null
```

`use()` records usage idempotently (by `usageId`) and the gateway settles it on-chain per its policy. When the budget/rate is exhausted, `use()` returns **402** — your service simply stops serving; no chain call needed in the hot path.

To report **raw quantities** instead of a pre-priced amount, configure the tenant with a `rateCard` and call `useMetered(mandateId, [{ meterKey, qty }], usageId)` — the gateway prices it on-chain and settles the frozen amount.

## Auth posture (secure by default)

The metered-report doors (`POST /usage`, `/usage-metered`) are **secure by default**: a tenant whose `agentAuthMode` is unset resolves to `'enforce'`, so a bare mandate id with no proof is rejected **403** (the mandate id is a *public* on-chain object — a bearer credential alone must not move money). Pick the mode per tenant:

| Deployment | `routing.agentAuthMode` | Thin-client call |
| --- | --- | --- |
| **Trusted merchant backend** self-metering its own users (the api-key lives only on your server — the api-key *is* the trust boundary) | `'off'` | `use(mandateId, amount, usageId)` — no proof |
| **Untrusted agent** reporting through a shared api-key (the agent must prove it owns the mandate) | `'enforce'` | `use(mandateId, amount, usageId, proof)` — pass an agent PoP |

The proof is an agent **proof-of-possession**: a one-time per-call signature plus a subscriber-signed binding cert (`signCall` / `issueAgentCert` in `@isubpay/sdk`). The same `proof` parameter applies to `useMetered`. Pinned end-to-end across all four modes by `npm run managed-thinclient:smoke` (and the raw-HTTP door by `npm run agent-auth-http:redteam`).

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

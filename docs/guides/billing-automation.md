# Billing automation (keeper & biller)

Two long-running components turn authorizations into charges. Use whichever fits your billing shape:

| Component | For | What it does |
| --- | --- | --- |
| **`IsubKeeper`** | Fixed subscriptions | Watches mandates, charges due ones, runs the `past_due → recovered \| lapsed` dunning state machine |
| **`IsubBiller`** | PAYG / metered | Records raw usage, prices it (optional RateCard), flushes seq-gated metered charges within the caps |

Both take an `IsubSigner` that must be the mandate's **merchant or authorized keeper**.

## The keeper (Fixed)

```typescript
import { IsubKeeper, keypairSigner } from '@isub/sdk';
import { fileStore } from '@isub/sdk/store-file';

const keeper = new IsubKeeper(isub, signer, [mandateId1, mandateId2], {
  store: fileStore('./.keeper/testnet'),  // durable watch set + journal; survives restarts
  onEvent: (e) => {
    if (e.type === 'charge.succeeded') console.log('charged', e.mandateId, e.amount, e.digest);
    else if (e.type === 'charge.failed') console.log('failed', e.mandateId, e.abortCode);
  },
});

await keeper.init();                 // load persisted tracks, take the single-instance lock
keeper.watch(mandateId3);            // a merchant backend adds mandates as users subscribe
await keeper.run({ pollMs: 1000, signal: ac.signal });
```

* The watch set is **explicit** — iSub doesn't event-scan the chain on the hot path. A merchant backend calls `watch(...)` on each new subscription; a standalone keeper merges ids from its persisted store on restart.
* `init()` takes a single-instance lock via the store, so two keepers don't double-charge.

## The biller (PAYG)

```typescript
import { IsubBiller } from '@isub/sdk/biller';
import { openDb } from '@isub/sdk/db';
import { sqlBillerStore } from '@isub/sdk/sql-store';

const db = openDb('isub-index.testnet.db');
const store = sqlBillerStore(db, 'acme');           // tenant-scoped, idempotent
const biller = new IsubBiller(isub, signer, store, {
  rateCard,                                          // optional; for raw-quantity metering
  onEvent: (e) => console.log(e.type, e.mandateId),
});

// 1) record usage as it happens (idempotent by usageId)
await biller.recordUsage({ mandateId, amount: 10_000_000n, usageId: 'req-1' });        // pre-priced
await biller.recordMeteredUsage({ mandateId, meterKey: 'calls', qty: 1n, usageId: 'req-2' }); // priced now

// 2) settle: batch unbilled usage → one or more chargeMetered calls
const results = await biller.flush(mandateId);       // FlushResult[]: { charged, carried, digest, reason }

// or run a loop:
await biller.run({ pollMs: 2000, signal: ac.signal, onTick: (rs) => {} });
```

What the biller guarantees:

* **Idempotent ingest** — duplicate `usageId` is a no-op (no double counting).
* **Cap-aware flush** — it shrinks the batch to fit `rateCap` (window), `maxPerCharge`, and remaining `totalBudget`, **carrying** the remainder to the next flush (`reason: 'rate_limited' | 'budget_exhausted' | …`).
* **Crash-safe charging** — it journals a `submit` (with exact batch membership) before charging and only marks usage billed after the charge lands; a timed-out submit is repaired by `recoverOrphan` using the seq, never re-billed.

## Choosing the charging key

`chargeMetered` (and the biller) must sign as the mandate's **merchant** or **`authorizedKeeper`** — both snapshotted from the plan at authorize time and immutable thereafter.

> **Use a dedicated keeper key for automation.** If you set a plan's `keeper` to your main wallet, the biller has to run with that hot key. Instead, create the plan with `keeper: <a key you use only for charging>`; the biller runs headless with it and your main wallet is never exposed. (A plan's keeper can't be changed after creation, and mandates snapshot it at authorize.)

## Localnet end-to-end (deterministic)

The repo ships runnable scripts that exercise the whole pipeline on a real chain:

```bash
# one terminal: a local Sui network with a faucet
sui start --force-regenesis --with-faucet

# another: publish + run the suites
cd sdk
npm run publish:localnet
npm run smoke           # Fixed lifecycle: charge, interval gate, revoke
npm run payg:smoke      # PAYG: rate cap, seq idempotency, refund
npm run pricing:smoke   # RateCard pricing → on-chain charge_metered
npm run rules:smoke     # the deduction-rule guards (EWrongAmount / EOverMaxPerCharge / EOverTotalBudget)
npm run managed-e2e     # gateway + dedicated keeper auto-charge, end to end
```

Append `:testnet` (e.g. `npm run managed-e2e:testnet`) to run against Sui testnet using funded actor keys under `.secrets/testnet/`.

# IsubKeeper

A long-running charger for **Fixed** subscriptions. It watches a set of mandates, charges due ones, and runs a dunning state machine (`active → past_due → recovered | lapsed`) with a durable store.

```typescript
import { IsubKeeper } from '@isub/sdk';

const keeper = new IsubKeeper(isub, signer, watch?, opts?);
```

* `isub` — `IsubClient`.
* `signer` — for Fixed charges this can be any address (charge is permissionless); typically the merchant or a dedicated keeper.
* `watch` — an iterable of initial mandate ids **or** the options bag (back-compat: if you pass options here, they're detected).
* `opts: KeeperOptions`.

```typescript
interface KeeperOptions {
  store?: KeeperStore;                  // durable watch set + tracks + single-instance lock (default: in-memory)
  dunning?: { graceMs: number };        // how long past_due before lapsing
  dueMarginMs?: number;                 // charge slightly early to absorb round-trip jitter
  onEvent?: (e: KeeperEvent) => void;
}
```

## Lifecycle

```typescript
await keeper.init();                          // load persisted tracks, merge seed ids, take the lock
keeper.watch(mandateId, mandateId2);          // add mandates (e.g. a backend on each new subscription)
keeper.unwatch(mandateId);                    // stop tracking
keeper.watching();                            // string[] of tracked ids
await keeper.run({ pollMs: 1000, signal });   // poll + charge due mandates until aborted
```

* The watch set is **explicit** — iSub doesn't event-scan the chain on the hot path. A merchant backend calls `watch(...)`; a standalone keeper resumes from its persisted store on restart.
* `init()` takes a single-instance lock through the store, so two keepers can't double-charge. Losing the lock stands the loop down.

## Persistence

```typescript
import { fileStore } from '@isub/sdk/store-file';
const store = fileStore('./.keeper/testnet'); // JSON-backed tracks + journal + lock
```

Other backends: `memoryStore()` (default, non-durable) and the SQL store for multi-tenant setups.

## Events

```typescript
onEvent: (e) => {
  switch (e.type) {
    case 'charge.succeeded': /* e.mandateId, e.amount, e.digest */ break;
    case 'charge.failed':    /* e.deterministic, e.abortCode */ break;
    // plus dunning transitions: past_due / recovered / lapsed
  }
}
```

## Dunning

When a due charge fails for a recoverable reason (e.g. `EInsufficientAccount`), the mandate enters `past_due`. The keeper keeps retrying within `dunning.graceMs`; if the account is topped up it `recovers`, otherwise it `lapses`. This is the subscription equivalent of card-retry logic.

## Fixed vs PAYG

`IsubKeeper` is for **Fixed** plans (fixed price, interval-gated). For **PAYG/metered** billing use [`IsubBiller`](biller.md) — it records usage and flushes seq-gated metered charges. They're complementary; a service that has both plan types runs both.

## Runnable

`npm run keeper -- 0x<mandateId> …` (`:testnet` variant) starts a keeper from `sdk/scripts/keeper.ts`, persisting under `.keeper/<network>`. Pass mandate ids as args; they merge into the persisted watch set.

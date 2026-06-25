# IsubClient

The high-level client. Builds a PTB, executes it through an `IsubSigner`, and parses ids / typed state. Writes return `{ digest, … }`; reads return `*State` objects.

```typescript
import { IsubClient } from '@isubpay/sdk';

const isub = new IsubClient({ client, packageId, coinType? });
isub.client;  // the underlying SuiGrpcClient (for raw reads like getBalance)
isub.cfg;     // { packageId, coinType }
```

`coinType` defaults to `0x2::sui::SUI`. For another coin, pass its fully-qualified type — but note the convenience `deposit`/`refund` auto-split SUI only; for other `<T>` build the tx with the low-level `tx.*` builders.

## Writes

All take an `IsubSigner` as the first argument.

| Method | Args | Returns |
| --- | --- | --- |
| `openAccount(signer)` | — | `{ digest, accountId }` |
| `deposit(signer, p)` | `{ accountId, amount }` | `{ digest }` |
| `withdraw(signer, p)` | `{ accountId, amount }` | `{ digest }` |
| `withdrawAll(signer, p)` | `{ accountId }` | `{ digest }` |
| `createPlanFixed(signer, p)` | `{ price, intervalMs, keeper }` | `{ digest, planId }` |
| `createPlanPayg(signer, p)` | `{ rateCap, rateWindowMs, keeper }` | `{ digest, planId }` |
| `deactivatePlan(signer, p)` | `{ planId }` | `{ digest }` |
| `authorizeFixed(signer, p)` | see below | `{ digest, mandateId }` |
| `authorizeMetered(signer, p)` | see below | `{ digest, mandateId }` |
| `charge(signer, p)` | `{ accountId, mandateId, amount }` | `{ digest }` |
| `chargeMetered(signer, p)` | `{ accountId, mandateId, amount, seq }` | `{ digest }` |
| `refund(signer, p)` | `{ accountId, mandateId, amount }` | `{ digest }` |
| `revoke(signer, p)` | `{ mandateId }` | `{ digest }` |
| `pause(signer, p)` | `{ mandateId }` | `{ digest }` |
| `resume(signer, p)` | `{ mandateId }` | `{ digest }` |
| `closeAccount` / `closeMandate` / `closePlan` | `{ accountId \| mandateId \| planId }` | `{ digest }` |

### `authorizeFixed(signer, p)`

```typescript
p: {
  accountId: string;
  planId: string;
  expectedPrice: bigint;          // terms the user reviewed (see Trusted display)
  expectedIntervalMs: bigint;
  expectedMerchant: string;
  totalBudget: bigint;
  expiryMs: bigint;
  firstChargeAfterMs?: bigint;    // default 0 = first charge due immediately
}
```

### `authorizeMetered(signer, p)`

```typescript
p: {
  accountId: string;
  planId: string;
  expectedRateCap: bigint;
  expectedRateWindowMs: bigint;
  expectedMerchant: string;
  expectedKeeper: string;
  totalBudget: bigint;
  expiryMs: bigint;
  maxPerCharge: bigint;           // user's per-charge throttle (> 0)
  firstChargeAfterMs?: bigint;
}
```

> The `expected*` fields are echoed to the contract and aborted on mismatch (`ETermsMismatch`). Pass what the user was shown — **not** values re-read from the plan. See [Trusted display](../concepts/trusted-display.md).

### `chargeMetered` idempotency

`seq` must equal the mandate's current `chargeSeq`. On a timed-out retry, resubmit the **same** seq — it lands once or aborts `EBadChargeSeq`. Never double-bills.

## Reads

| Method | Returns |
| --- | --- |
| `getAccount(id)` | `AccountState` |
| `getPlan(id)` | `PlanState` |
| `quoteFromPlan(id)` | `PlanState` (display-only alias of `getPlan`) |
| `getMandate(id)` | `MandateState` |
| `getMandates(ids)` | `MandateState[]` |
| `getMandatesResolved(ids)` | `{ id, mandate: MandateState \| null }[]` — tolerates deleted/unreadable ids |

See [Core concepts](../concepts/core-concepts.md) for the `AccountState` / `PlanState` / `MandateState` field definitions.

## Helpers (top-level exports)

* `accountExposure(isub, accountId, mandateIds)` → total-exposure view ([Non-custodial](../concepts/non-custodial.md)).
* `scheduleLag(chain, ids, opts)` → arrears/visibility scheduling for due mandates.
* `tx.*` → low-level PTB builders for composing several calls into one transaction.

## Errors

Writes that abort throw `IsubAbortError` (with `.abortCode`); decode with `abortCodeOf(e)` / `errorName(code)`. See [Errors](errors.md).

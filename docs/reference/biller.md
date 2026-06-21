# IsubBiller

Turns **PAYG usage** into **metered on-chain charges**: record usage (optionally priced by a RateCard), then flush it into `chargeMetered` calls that respect every cap and never double-bill.

```typescript
import { IsubBiller } from '@isub/sdk/biller';

const biller = new IsubBiller(chain, signer, store, {
  policy?: BillerPolicy,
  onEvent?: (e: BillerEvent) => void,
  rateCard?: RateCard,   // enables recordMeteredUsage (raw qty → MIST, frozen at ingest)
});
```

* `chain` — an `IsubClient` (or any `BillerChain`: `getMandate` / `getAccount` / `chargeMetered`).
* `signer` — must be the mandate's **merchant or authorized keeper**.
* `store` — a `BillerStore` (e.g. `sqlBillerStore(db, tenantId)` from `@isub/sdk/sql-store`, or `memBillerStore()`).

## Recording usage

```typescript
// pre-priced amount (you computed the MIST yourself)
await biller.recordUsage({ mandateId, amount: 10_000_000n, usageId: 'req-1', atMs? });

// raw quantity priced by the RateCard at THIS moment (frozen):
await biller.recordMeteredUsage({ mandateId, meterKey: 'tokens.in', qty: 50_000n, usageId: 'req-2', atMs? });
```

* **Idempotent by `usageId`** — recording the same id twice is a no-op. Use a stable id per billable event (request id, invoice line, etc.).
* `recordMeteredUsage` requires a `rateCard`; the price is computed and **stored** now, so a later card edit never re-prices past usage.

## Flushing (settling on-chain)

```typescript
const results: FlushResult[] = await biller.flush(mandateId? , nowMs?);
// FlushResult: { mandateId, charged: bigint, carried: bigint, digest?: string, reason }
```

`flush` batches a mandate's unbilled usage and issues one or more `chargeMetered` calls, **shrinking the batch to fit**:

* the rolling `rateCap` for the current window,
* the user's `maxPerCharge`,
* the remaining `totalBudget`,

and **carries** the remainder to the next flush. `reason` ∈ `'charged' | 'rate_limited' | 'budget_exhausted' | 'insufficient_balance' | 'per_charge_too_small' | 'not_billable'`. Omit the id to flush all mandates with unbilled usage.

## Running a loop

```typescript
const ac = new AbortController();
await biller.run({ pollMs: 2000, signal: ac.signal, onTick: (rs) => {} });
```

If the store supports locking, `run` holds a single-instance lock (heartbeat-renewed) so two billers don't double-charge; losing the lock stands the loop down with an `IsubError('lock')`.

## `spendable`

```typescript
const max = await biller.spendable(mandateId); // bigint: what could be charged right now
```

The most that could be charged this instant = `min(remaining budget, remaining rate-cap window, maxPerCharge, account balance)`.

## Events (`BillerEvent`)

```typescript
| { type: 'charge.succeeded'; mandateId; at; amount; digest; seq }
| { type: 'charge.failed';    mandateId; at; error; deterministic; abortCode }
| { type: 'usage.carried';    mandateId; at; amount; reason }
| { type: 'budget.threshold'; mandateId; at; pct }
| { type: 'budget.exhausted'; mandateId; at }
| { type: 'mandate.expired';  mandateId; at }
```

`charge.failed` with `deterministic: false` is a transient (RPC) error that gets retried; `deterministic: true` carries an `abortCode`.

## Crash-safety

The biller journals a `submit` entry **with the exact batch membership** before charging, and only marks usage billed **after** the charge lands. A timed-out submit (charge maybe landed, ack lost) is repaired on the next attempt by `recoverOrphan`, which maps the landed charge to its records via the `seq` — so usage is never re-billed and never silently dropped.

## Policy

```typescript
interface BillerPolicy {
  maxRetries?: number;   // transient-retry budget per flush (default 5)
  windowMs?: number;     // settle cadence used by the gateway
  // …
}
```

## Where it persists

`sqlBillerStore(db, tenantId)` writes `usage_records` + a `charges` journal keyed by `mandate_id`. Point it at the **gateway's** index db (`isub-index.<network>.db`) so the dashboard's [usage views](managed-gateway.md) read the same rows. See [Billing automation](../guides/billing-automation.md) for the full runnable setup.

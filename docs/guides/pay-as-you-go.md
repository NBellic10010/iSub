# Pay-as-you-go (metered)

A **PAYG** plan charges variable amounts driven by usage, capped at `rateCap` per rolling `rateWindowMs`. Ideal for APIs, GPU time, tokens, storage — anything billed by consumption.

## 1. Publish the plan (merchant)

```typescript
const { planId } = await isub.createPlanPayg(merchant, {
  rateCap: 100_000_000n,    // ≤ 0.1 SUI per window
  rateWindowMs: 60_000n,    // 60s rolling window
  keeper: keeper.address,   // ONLY merchant or this keeper may chargeMetered
});
```

## 2. Authorize (subscriber)

```typescript
const { mandateId } = await isub.authorizeMetered(subscriber, {
  accountId, planId,
  expectedRateCap: 100_000_000n,
  expectedRateWindowMs: 60_000n,
  expectedMerchant: merchant.address,
  expectedKeeper: keeper.address,
  totalBudget: 200_000_000n,   // lifetime ceiling
  maxPerCharge: 50_000_000n,   // user's per-charge throttle (independent of rateCap)
  expiryMs: BigInt(Date.now() + 30 * 86_400_000),
});
```

`maxPerCharge` is the **user's own** slope limit — it caps any single charge regardless of the merchant's `rateCap`, turning "drain the whole budget in one shot" into "rhythmic charges," which buys time to revoke.

## 3. Charge metered usage (merchant/keeper)

```typescript
let m = await isub.getMandate(mandateId);
await isub.chargeMetered(keeper, {
  accountId, mandateId,
  amount: 10_000_000n,   // ≤ rateCap (window) AND ≤ maxPerCharge AND ≤ remaining budget
  seq: m.chargeSeq,      // idempotency — must equal the mandate's current chargeSeq
});
```

* **Authorized callers only:** merchant or the plan's keeper (`ENotAuthorizedCharger` otherwise).
* **Idempotent:** `seq` must equal `chargeSeq`. On a timed-out retry resubmit the same seq — it lands once or aborts `EBadChargeSeq`. Never double-bills.
* **Rate-limited:** `windowSpent + amount ≤ rateCap`, with the window resetting after `rateWindowMs`.

You almost never call `chargeMetered` by hand — the [biller](billing-automation.md) records raw usage and flushes priced charges for you.

## Pricing usage with a RateCard

Most PAYG services meter **raw quantities** (tokens, calls, GB), not SUI. A `RateCard` converts quantities → an exact MIST amount, **frozen at ingest** so a later price change never re-prices past usage.

```typescript
import { priceUsageMulti, type RateCard } from '@isubpay/sdk';

const card: RateCard = {
  version: 1,
  rounding: 'ceil',
  meters: {
    'tokens.in':  { key: 'tokens.in',  priceNum: 400_000n,   priceDen: 1n, units: 1_000n }, // 0.0004 SUI / 1k
    'tokens.out': { key: 'tokens.out', priceNum: 1_200_000n, priceDen: 1n, units: 1_000n },
    'calls':      { key: 'calls',      priceNum: 1_000_000n, priceDen: 1n, units: 1n },      // 0.001 SUI / call
  },
};

const { amount, lines, cardVersion } = priceUsageMulti(card, [
  { meterKey: 'tokens.in',  qty: 50_000n },
  { meterKey: 'tokens.out', qty: 10_000n },
  { meterKey: 'calls',      qty: 1n },
]);
// amount = 0.033 SUI (in MIST); lines = per-meter breakdown; cardVersion = 1
```

A `Meter` is an exact rational price `priceNum / (priceDen × units)` with optional `includedQty` (free quota, subtracted before pricing) and `minCharge` (per-record floor). See [Pricing reference](../reference/pricing.md) for every field, rounding modes, and `assertRateCardFits` (which fails loud at ingest if a meter's minimum could never fit the mandate's caps).

## End-to-end with the biller

```typescript
import { IsubBiller } from '@isubpay/sdk/biller';

const biller = new IsubBiller(isub, keeper, store, { rateCard: card });

// the service reports raw usage as it happens (priced + frozen at this moment):
await biller.recordMeteredUsage({ mandateId, meterKey: 'tokens.in', qty: 50_000n, usageId: 'req-1' });

// later, settle pending usage into on-chain charges (seq-gated, rate/budget-aware):
const results = await biller.flush(mandateId);
```

The biller batches unbilled usage, respects the rate cap/`maxPerCharge`/budget (carrying the remainder), and is idempotent by `usageId` and `seq`. See [Billing automation](billing-automation.md).

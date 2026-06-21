# Pricing (RateCard)

A pure, dependency-free pricing layer that converts **raw usage quantities** (tokens, calls, GB) into an exact MIST `amount`, with integer-exact rational prices and explicit rounding. Used by `IsubBiller.recordMeteredUsage`, but usable standalone.

```typescript
import { priceUsage, priceUsageMulti, assertValidRateCard, assertRateCardFits } from '@isub/sdk';
import type { RateCard, Meter, Rounding } from '@isub/sdk';
```

## `Meter`

An exact rational unit price: `priceNum` MIST per `(priceDen × units)` of qty.

```typescript
interface Meter {
  key: string;            // stable provenance key, e.g. 'tokens.in' | 'calls' | 'gb'
  priceNum: bigint;       // numerator (MIST), ≥ 0
  priceDen: bigint;       // denominator, > 0 (lets you express sub-MIST per unit)
  units: bigint;          // qty granularity: price applies per this many qty, > 0
  includedQty?: bigint;   // free quota subtracted BEFORE pricing (per-usageId, one-shot), ≥ 0
  minCharge?: bigint;     // per-record floor (MIST) after rounding, only when billable (eff > 0), ≥ 0
  rounding?: Rounding;    // per-meter override; falls back to card.rounding, then 'ceil'
}
```

Examples:

```typescript
{ key: 'tokens.in', priceNum: 3n,   priceDen: 1000n, units: 1n }   // 3 MIST / 1000 tokens
{ key: 'calls',     priceNum: 500n, priceDen: 1n,    units: 1n }   // 500 MIST / call
```

## `RateCard`

```typescript
interface RateCard {
  version: number;                        // bump on ANY change; stored as per-row provenance, never re-priced from
  rounding?: Rounding;                    // card default ('ceil' if unset)
  meters: Readonly<Record<string, Meter>>;
}

type Rounding = 'ceil' | 'floor' | 'half_up';   // default 'ceil'
```

## Pricing functions

```typescript
// one meter
const amount: bigint = priceUsage(card, 'tokens.in', 50_000n);

// many meters at once
const { amount, lines, cardVersion } = priceUsageMulti(card, [
  { meterKey: 'tokens.in',  qty: 50_000n },
  { meterKey: 'tokens.out', qty: 10_000n },
  { meterKey: 'calls',      qty: 1n },
]);
// PriceResult: { amount, lines: { meterKey, qty, amount }[], cardVersion }
```

Pricing math per meter: `eff = max(0, qty − includedQty)`; `amount = round(eff × priceNum / (priceDen × units))`; `minCharge` applies **only when `eff > 0`**. All integer-exact (bigint) — no floats.

## Freeze at ingest

Price usage **when it happens** and store the result. A `RateCard` version is recorded as provenance but the stored amount is never recomputed — so editing the card (and bumping `version`) never re-prices past usage. `IsubBiller.recordMeteredUsage` does this for you.

## Validation

```typescript
assertValidRateCard(card);   // throws IsubError('config', …) on any malformed meter (at construction)
```

```typescript
const problems = assertRateCardFits(card, mandate);  // RateCardFitProblem[]
// codes: 'min_exceeds_max_per_charge' | 'min_exceeds_rate_cap'
//      | 'min_exceeds_budget_left'    | 'unit_exceeds_max_per_charge' | 'not_payg'
```

`assertRateCardFits` **fails loud at ingest** rather than at flush: if a meter's `minCharge` (or single-unit price) could never fit the mandate's `maxPerCharge` / `rateCap` / remaining budget, you find out when configuring, not when a charge silently can't settle. The contract also enforces a u64 ceiling on any single charge amount, checked here too.

See it end-to-end in `sdk/scripts/pricing-smoke.ts` (raw usage → frozen price → on-chain `chargeMetered`, asserting on-chain amount == off-chain price).

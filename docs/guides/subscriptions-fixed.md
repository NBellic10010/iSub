# Subscriptions (Fixed)

A **Fixed** plan charges a fixed `price` no more often than `intervalMs`. It's the classic recurring subscription.

## 1. Publish the plan (merchant)

```typescript
const { planId } = await isub.createPlanFixed(merchant, {
  price: 50_000_000n,      // 0.05 SUI per period
  intervalMs: 2_592_000_000n, // ~30 days
  keeper: keeper.address,  // who you'll let trigger charges (can be the merchant itself)
});
```

`keeper` is the address you intend to run the charging loop with. For Fixed plans `charge` is permissionless anyway, but the field is recorded for consistency with PAYG.

## 2. Authorize (subscriber)

```typescript
const { mandateId } = await isub.authorizeFixed(subscriber, {
  accountId,
  planId,
  expectedPrice: 50_000_000n,        // terms the user reviewed (see Trusted display)
  expectedIntervalMs: 2_592_000_000n,
  expectedMerchant: merchant.address,
  totalBudget: 600_000_000n,         // e.g. ~12 periods
  expiryMs: BigInt(Date.now() + 365 * 86_400_000),
  firstChargeAfterMs: 0n,            // 0 = first charge due immediately (Stripe-style)
});
```

* **`firstChargeAfterMs`** sets a trial / delayed first charge. `0n` ⇒ chargeable right away. The contract sets `notBeforeMs = now + firstChargeAfterMs`; charges before it abort `EIntervalNotElapsed`.
* `maxPerCharge` is implicitly `price` for Fixed — you don't pass it.

## 3. Charge each period

`charge` is **permissionless** for Fixed: any address can trigger a due charge (the contract enforces the exact `price`, the interval, the budget, the balance). In practice you let the [keeper](billing-automation.md) do it on a schedule.

```typescript
await isub.charge(keeper, { accountId, mandateId, amount: 50_000_000n });
```

* Must be **exactly** `price` → else `EWrongAmount`.
* Must be `now ≥ lastChargedMs + intervalMs` → else `EIntervalNotElapsed`.
* On success, `lastChargedMs = now` (so a single transaction can't claim multiple periods).

### Automating it

Hand the mandate to an `IsubKeeper`, which tracks due mandates and runs the dunning state machine (`past_due → recovered | lapsed`):

```typescript
import { IsubKeeper } from '@isub/sdk';

const keeperLoop = new IsubKeeper(isub, keeper, [mandateId], {
  onEvent: (e) => console.log(e.type, e.mandateId),
});
await keeperLoop.init();
await keeperLoop.run({ pollMs: 1000 }); // long-running; pass an AbortSignal to stop
```

See [IsubKeeper](../reference/keeper.md).

## 4. Pause / resume / cancel (subscriber)

```typescript
await isub.pause(subscriber, { mandateId });   // temporarily stop charges
await isub.resume(subscriber, { mandateId });  // resets the billing cursor to now (pause = forgiveness, not deferral)
await isub.revoke(subscriber, { mandateId });  // terminal; charges then abort ENotActive
```

`resume` pulls `lastChargedMs` (and the PAYG window) to `now`, so the merchant cannot back-charge the paused period.

## Reading state

```typescript
const m = await isub.getMandate(mandateId);
// m.spentTotal / m.totalBudget, m.lastChargedMs, m.status, m.expiryMs
```

For a wallet view of several mandates at once: `getMandates(ids)` or `getMandatesResolved(ids)` (the latter returns `{ id, mandate | null }`, tolerating deleted/unreadable ids).

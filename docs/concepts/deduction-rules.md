# Deduction rules

Every charge is gated by the Move contract. The merchant's backend is **not** trusted — if a charge breaks any rule, the transaction aborts and **no funds move**. These are the rules, by mode.

## Shared gates (both modes)

A charge aborts unless **all** hold:

| Rule | Abort | Meaning |
| --- | --- | --- |
| Mandate is `Active` | `ENotActive` (#4) | not paused/revoked |
| `now < expiryMs` | `EExpired` (#5) | not past expiry |
| `now ≥ notBeforeMs` | `EIntervalNotElapsed` (#6) | past the user's first-charge delay |
| `amount ≤ maxPerCharge` | `EOverMaxPerCharge` (#24) | within the user's per-charge throttle |
| `spentTotal + amount ≤ totalBudget` | `EOverTotalBudget` (#9) | within the lifetime cap |
| `account.balance ≥ amount` | `EInsufficientAccount` (#10) | account funded |
| `mandate.accountId == account` | `EAccountMismatch` (#13) | right account passed |

## Fixed (`charge`)

`charge(account, mandate, amount, clock)` — **permissionless** (anyone can trigger a due charge).

| Rule | Abort |
| --- | --- |
| `mode == Fixed` | `EBadMode` (#12) |
| `amount == price` (exact) | `EWrongAmount` (#7) |
| `now ≥ lastChargedMs + intervalMs` | `EIntervalNotElapsed` (#6) |

On success the contract sets `lastChargedMs = now` (not `+= interval`), so a single PTB can't drain several periods at once.

```typescript
// due immediately after authorize (Stripe-style); a second call before the interval aborts #6
await isub.charge(keeper, { accountId, mandateId, amount: price });
```

## Pay-as-you-go (`chargeMetered`)

`chargeMetered(account, mandate, amount, seq, clock)` — **merchant or `authorizedKeeper` only**.

| Rule | Abort |
| --- | --- |
| `mode == Payg` | `EBadMode` (#12) |
| caller ∈ {merchant, authorizedKeeper} | `ENotAuthorizedCharger` (#3) |
| `seq == chargeSeq` (idempotency) | `EBadChargeSeq` (#20) |
| `windowSpent + amount ≤ rateCap` (rolling) | `EOverRateCap` (#8) |

The rolling window resets when `now ≥ windowStartMs + rateWindowMs`, then `windowSpent` starts fresh.

```typescript
let m = await isub.getMandate(mandateId);
await isub.chargeMetered(keeper, { accountId, mandateId, amount, seq: m.chargeSeq });
```

### The idempotency seq (never double-bill)

`seq` must equal the mandate's current `chargeSeq`. On a **timed-out retry, resubmit the same seq**: it either lands exactly once, or aborts `EBadChargeSeq` because the charge already happened. This is how the [biller](../guides/billing-automation.md) survives flaky RPC without ever double-charging.

## Refunds (`refund`)

`refund(account, mandate, coin)` — **merchant only**. Returns funds **to the Account** (not the wallet), and:

* aborts `ERefundExceedsSpent` (#21) if cumulative refunds would exceed `spentTotal`;
* aborts `ENotMerchant` (#22) if the caller isn't the merchant;
* does **not** restore `totalBudget` (gross is monotone) — it records `refundedTotal` separately;
* works even after revoke/expiry (refunding a final charge after cancellation is normal).

## Caps cheat-sheet

| Cap | Where set | Enforces |
| --- | --- | --- |
| `maxPerCharge` | subscriber, at authorize | size of any single charge (slope) |
| `rateCap` / `rateWindowMs` | merchant, on the plan | spend per rolling window (PAYG) |
| `intervalMs` | merchant, on the plan | minimum spacing (Fixed) |
| `totalBudget` | subscriber, at authorize | lifetime ceiling (total exposure) |
| `expiryMs` | subscriber, at authorize | hard stop time |

See the full numeric list in [Abort codes](../contracts/abort-codes.md).

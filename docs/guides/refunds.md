# Refunds

A merchant can return funds to a subscriber at any time with `refund`. Refunds go **back into the subscriber's `Account`** (not their wallet) — funds stay inside the system, withdrawable by the user whenever they like.

## Basic refund

```typescript
await isub.refund(merchant, {
  accountId,
  mandateId,
  amount: 50_000_000n,   // 0.05 SUI back into the account
});
```

For SUI the amount is auto-split from the merchant's gas coin. For another `<T>`, build the transaction with an explicit `Coin<T>` via the low-level `tx.refund(...)` builder.

## Rules

| Rule | Abort |
| --- | --- |
| caller is the mandate's merchant | `ENotMerchant` (#22) |
| `amount > 0` | `EWrongAmount` (#7) |
| `refundedTotal + amount ≤ spentTotal` | `ERefundExceedsSpent` (#21) |

* **No status/expiry check.** You can refund after the subscriber has revoked or the mandate has expired — refunding a final charge after cancellation is normal and supported.
* **Budget is not restored.** `totalBudget` consumption is on the **gross** `spentTotal`; refunds accumulate in `refundedTotal` separately. This prevents charge↔refund round-trips from "washing" the lifetime cap back open.

## Net spend

```typescript
const m = await isub.getMandate(mandateId);
const netSpend = m.spentTotal - m.refundedTotal;
```

Use `spentTotal − refundedTotal` whenever you display "how much this subscription has actually cost." The gateway's usage/charges views and webhooks expose both figures.

## Partial vs full

There's no separate "full refund" call — refund the exact amount you intend (up to `spentTotal − refundedTotal`). To make a subscriber whole after cancellation:

```typescript
await isub.revoke(subscriber, { mandateId });            // (subscriber) cancel
const m = await isub.getMandate(mandateId);
const owed = m.spentTotal - m.refundedTotal;             // remaining refundable
if (owed > 0n) await isub.refund(merchant, { accountId, mandateId, amount: owed });
```

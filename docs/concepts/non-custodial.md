# Non-custodial by design

The defining property of iSub: **funds stay in the subscriber's own `Account` until the instant a charge pulls them, and the subscriber can withdraw at any time.** Authorizing a mandate moves nothing.

## What "non-custodial" means here

* **Authorize ≠ pay.** `authorizeFixed` / `authorizeMetered` create a `Mandate` (a permission). They transfer **0** coins. You can verify this: the account balance is identical before and after.
* **The user owns the balance.** Only `account.owner` can `withdraw` / `withdrawAll`. The merchant, the keeper, and the contract author cannot move funds out of an account — they can only `charge` within an active mandate's caps.
* **Cancel is unilateral.** `revoke` (terminal), `pause`, and `withdraw` need only the subscriber's signature. No merchant cooperation, no support ticket.
* **The merchant never custodies.** A merchant collects via `charge`/`chargeMetered` and can `refund` — but cannot pause, cancel, raise a cap, or hold a balance.

Contrast with Stripe (custodial token vault) or a streaming-payment lock-up (funds escrowed up front). iSub has **no pre-funding and no escrow** — just a capped right to pull.

## Total exposure across mandates

One account can back many mandates, and charges draw first-come-first-served. So a user's realistic worst case toward an account is **`min(balance, Σ remaining authorizations)`**. Surface it before the user signs another authorize:

```typescript
import { accountExposure } from '@isub/sdk';

const x = await accountExposure(isub, accountId, mandateIds);
// {
//   balance,            // current spendable
//   totalAuthorized,    // Σ (totalBudget − spentTotal) over ACTIVE mandates on this account
//   atRisk,             // min(balance, totalAuthorized) — realistic worst case now
//   overAuthorized,     // totalAuthorized > balance (mandates contend; some charges may fail)
//   byMandate: [{ mandateId, merchant, remaining }]
// }
```

`mandateIds` is supplied by the caller (the same discovery model as the keeper) — pass the ids you know about for this account. Only **active** mandates actually bound to `accountId` count.

A wallet or checkout can show *"you're authorizing a total of X against an account holding Y"* — and warn when `overAuthorized` is true.

## Keeping exposure low

* Set a tight **`maxPerCharge`** so a compromised keeper/merchant can only pull a small slice per charge, buying the user time to `revoke`/`withdraw`.
* Set a realistic **`totalBudget`** and **`expiryMs`** — the mandate self-limits even if forgotten.
* Deposit only what's needed. The account isn't a vault; top it up as you go.

## Privacy note

iSub deliberately does **not** mix funds or hide the payment graph — plans, mandates, and charges are public on-chain objects/events (that's what makes the caps auditable). For unlinkability, a subscriber can use a fresh account/address per merchant. See the project's `product-plan/privacy.md` for the threat model.

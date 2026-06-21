# Account · Plan · Mandate

iSub is three shared on-chain objects plus a settlement function. Everything in the SDK maps to these.

## `Account<T>` — the subscriber's balance

A reusable, **owner-withdrawable** balance. The user deposits once and many mandates can draw from it.

```typescript
interface AccountState {
  id: string;
  owner: string;     // only this address can withdraw
  balance: bigint;   // spendable, in base units (MIST for SUI)
}
```

* Created with `openAccount`, funded with `deposit`, drained with `withdraw` / `withdrawAll`.
* **Non-custodial:** the funds are the user's until the instant a charge pulls them. No one else can move them out.
* One account backs many subscriptions. Because charges draw first-come-first-served, see [`accountExposure`](non-custodial.md) for the "how much is really at risk" view.

## `Plan<T>` — the merchant's offer

The terms a merchant publishes. Two modes from one struct:

```typescript
interface PlanState {
  id: string;
  merchant: string;        // payee + the only address that can deactivate it
  mode: ChargeMode;        // Fixed (0) | Payg (1)
  price: bigint;           // Fixed: per-period price · PAYG: 0
  intervalMs: bigint;      // Fixed: min ms between charges · PAYG: 0
  rateCap: bigint;         // PAYG: max spend per rolling window · Fixed: 0
  rateWindowMs: bigint;    // PAYG: window length · Fixed: 0
  keeper: string;          // address authorized to trigger metered charges
  active: boolean;
}
```

* `createPlanFixed` → a **subscription** (fixed `price` every `intervalMs`).
* `createPlanPayg` → **metered** billing (variable amounts, capped at `rateCap` per `rateWindowMs`).
* `deactivatePlan` takes it off sale (one-way): blocks **new** authorizes, leaves existing mandates untouched.

## `Mandate<T>` — the capped authorization

The heart of iSub: a **revocable pull authorization that holds no funds**. The subscriber signs it once; it snapshots the plan's terms and the user's caps.

```typescript
interface MandateState {
  id: string;
  accountId: string;       // the account it draws from
  subscriber: string;      // who authorized it (only they can pause/revoke)
  merchant: string;        // payee
  planId: string;
  mode: ChargeMode;

  // Fixed
  price: bigint;
  intervalMs: bigint;
  lastChargedMs: bigint;

  // PAYG
  rateCap: bigint;
  rateWindowMs: bigint;
  windowStartMs: bigint;
  windowSpent: bigint;
  authorizedKeeper: string;

  // shared caps
  maxPerCharge: bigint;    // user's per-charge ceiling (Fixed: == price)
  totalBudget: bigint;     // lifetime ceiling
  spentTotal: bigint;      // gross charged so far (monotone)
  refundedTotal: bigint;   // refunded back to the Account (does NOT restore budget)
  expiryMs: bigint;
  notBeforeMs: bigint;     // earliest chargeable time
  chargeSeq: bigint;       // +1 per charge; PAYG idempotency anchor

  status: MandateStatus;   // Active (0) | Paused (1) | Revoked (2)
}
```

The mandate is the user's contract with the merchant, expressed as enforceable on-chain limits. The merchant can **collect** and **refund** within it but can never **pause, cancel, raise a cap, or touch the account** — only the subscriber can.

## The lifecycle

```
openAccount ─▶ deposit ─▶ authorizeFixed / authorizeMetered ─▶ charge / chargeMetered (×N)
                                                                      │
   subscriber, anytime: pause ─ resume ─ revoke ─ withdraw ◀──────────┘
   merchant, anytime:   refund
   cleanup (terminal):  closeMandate ─ closeAccount ─ closePlan  (reclaim storage rebate)
```

* **Net spend** of a mandate = `spentTotal − refundedTotal`. Budget is consumed on the gross (`spentTotal`) so charge↔refund round-trips can't "wash" the cap back open.
* A revoked mandate is **terminal**; charges against it abort `ENotActive`.

Next: the exact [deduction rules](deduction-rules.md) the contract enforces on every charge.

# Trusted display & terms-binding

A subscriber should only ever sign terms they actually saw. iSub enforces this on-chain with **terms-binding**, and the SDK/checkout give you a neutral surface to show those terms.

## The problem

The merchant controls the page where the user clicks "Subscribe." A malicious or buggy merchant could **show** one price and **authorize** another, or swap the plan id at the last moment. A signature alone doesn't prove the user agreed to the real terms.

## The mechanism: `expected*` echoes

`authorizeFixed` / `authorizeMetered` take `expected*` fields — the terms the **user reviewed**. The Move contract aborts with `ETermsMismatch` (#23) unless they equal the live `Plan`:

```typescript
await isub.authorizeMetered(subscriber, {
  accountId, planId,
  expectedRateCap: 100_000_000n,        // what the user was shown
  expectedRateWindowMs: 60_000n,
  expectedMerchant: merchant.address,   // the payee they agreed to
  expectedKeeper: keeper.address,       // the charger they implicitly trust
  totalBudget, maxPerCharge, expiryMs,
});
```

For PAYG both `merchant` (payee) and `keeper` (authorized charger) are bound — the two addresses a user most needs to confirm. For Fixed, `price`, `intervalMs`, and `merchant` are bound.

> ⚠️ **Do not source `expected*` by re-reading the plan you're authorizing.** That makes the check a tautology (the plan always equals itself). Pass the values the user was shown on a trusted surface.

## `quoteFromPlan` is display-only

```typescript
const plan = await isub.quoteFromPlan(planId); // PlanState — for rendering terms to the user
```

`quoteFromPlan` reads the plan's **current** terms so you can render them. It is explicitly **not** a safe source for `expected*`: by the time you authorize, the rendered values are what the user reviewed, and those are what you echo. The distinction is the whole point — the human-reviewed values and the on-chain values must be made to match by the *contract*, not by your code copying one into the other.

## The isolated checkout

The [checkout widget](../guides/checkout-widget.md) runs on **iSub's origin inside an iframe**, not the merchant's page:

* The merchant passes only a `planId` + a budget via URL params.
* The widget reads the **real** terms from chain (`quoteFromPlan`) and renders them itself — the merchant can't restyle or fake this surface.
* Optionally it captures an explicit human-readable **signed consent** (`signPersonalMessage`) before the on-chain authorize.

```
merchant page ──(planId, budget)──▶ iframe @ isub origin
                                      │  reads real terms from chain
                                      │  shows them; user reviews
                                      ▼
                          authorize(expected* = shown terms)  ──▶ chain verifies == Plan
```

## Consent text

When `consent` is enabled, the widget signs a plain-language intent before authorizing, e.g.:

```
I authorize iSub to charge up to 0.1 SUI per 60s window
to merchant 0x…,
up to a total of 0.2 SUI, for 30 days.
Funds stay in my wallet; I can cancel anytime.
```

This is an off-chain attestation that complements the on-chain terms-binding — together they make "the user agreed to exactly these terms" verifiable from both sides.

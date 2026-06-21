# Object model

The on-chain module is `isub::subscription` (`contracts/sources/subscription.move`). Everything is built from three **shared** objects parameterized by a coin type `<T>`.

| Object | Created by | Holds funds? | Who can mutate |
| --- | --- | --- | --- |
| `Account<T>` | `open_account` | **Yes** (the user's balance) | owner withdraws; charges pull; merchant refunds in |
| `Plan<T>` | `create_plan_fixed` / `create_plan_payg` | No | merchant (deactivate); else immutable terms |
| `Mandate<T>` | `authorize_fixed` / `authorize_metered` | **No** | subscriber (pause/resume/revoke); charges update counters |

All three are `transfer::share_object`, so they're reachable by id from any transaction. See [Core concepts](../concepts/core-concepts.md) for the parsed TypeScript shapes.

## Entry functions

```move
// account (subscriber)
public fun open_account<T>(ctx)
public fun deposit<T>(account, coin)
public fun withdraw<T>(account, amount, recipient, ctx)
public fun withdraw_all<T>(account, recipient, ctx)
public fun close_account<T>(account, ctx)          // requires balance == 0

// plan (merchant)
public fun create_plan_fixed<T>(price, interval_ms, keeper, ctx)
public fun create_plan_payg<T>(rate_cap, rate_window_ms, keeper, ctx)
public fun deactivate_plan<T>(plan, ctx)           // merchant only, one-way
public fun close_plan<T>(plan, ctx)

// mandate (subscriber authorizes; terms echoed for binding)
public fun authorize_fixed<T>(account, plan, expected_price, expected_interval_ms,
                              expected_merchant, total_budget, expiry_ms, first_charge_after_ms, clock, ctx)
public fun authorize_metered<T>(account, plan, expected_rate_cap, expected_rate_window_ms,
                              expected_merchant, expected_keeper, total_budget, expiry_ms,
                              max_per_charge, first_charge_after_ms, clock, ctx)
public fun pause<T>(mandate, ctx)
public fun resume<T>(mandate, clock, ctx)
public fun revoke<T>(mandate, ctx)                 // terminal
public fun close_mandate<T>(mandate, ctx)          // requires revoked

// charging & refunds
public fun charge<T>(account, mandate, amount, clock, ctx)            // Fixed; permissionless
public fun charge_metered<T>(account, mandate, amount, seq, clock, ctx) // PAYG; merchant/keeper only
public fun refund<T>(account, mandate, coin, ctx)                     // merchant only
```

## Settlement

Both charge paths converge on a private `settle()` — the single money-moving exit. It enforces, in order: `amount ≤ max_per_charge` (`EOverMaxPerCharge`), `spent_total + amount ≤ total_budget` (`EOverTotalBudget`), `balance ≥ amount` (`EInsufficientAccount`); then increments `spent_total` and `charge_seq`, splits the coin from the account, transfers it to the merchant, and emits `Charged`. Funds conservation lives in exactly one place.

## Generic coin `<T>`

The default deployment binds `<T> = 0x2::sui::SUI`, but the primitive is generic — moving to USDC/USDsui in production is only a type-argument change. The SDK's convenience `deposit`/`refund` auto-split SUI; for other coins, supply a `Coin<T>` via the low-level `tx.*` builders.

## Versioning

Each object carries a `version`. Entry functions assert it equals the package's current `VERSION` (`EWrongVersion`); after a package upgrade, objects are migrated before use. This prevents a stale object from being operated on by mismatched logic.

## Tests

The Move test suite (`contracts/tests/subscription_tests.move`) covers the rules end-to-end — interval gating, terms-binding, seq idempotency, rate/budget/per-charge caps, refund accounting, keeper authorization, and versioning. Run with `sui move test`.

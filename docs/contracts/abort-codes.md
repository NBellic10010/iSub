# Abort codes

Every guard in `isub::subscription` aborts with a numeric code. The SDK mirrors them in `ERROR_CODES` and decodes them with `errorName(code)` / `abortCodeOf(e)`.

```typescript
import { ERROR_CODES, errorName, abortCodeOf } from '@isub/sdk';
errorName(8);        // 'EOverRateCap'
abortCodeOf(err);    // 8 | null
```

| # | Name | Meaning |
| --- | --- | --- |
| 1 | `ENotOwner` | not the `Account` owner |
| 2 | `ENotSubscriber` | not the `Mandate`'s subscriber |
| 3 | `ENotAuthorizedCharger` | metered charge by someone other than merchant/keeper |
| 4 | `ENotActive` | mandate not Active (paused/revoked) |
| 5 | `EExpired` | past `expiry_ms` |
| 6 | `EIntervalNotElapsed` | before `notBefore` or the next interval (Fixed) |
| 7 | `EWrongAmount` | Fixed charge ≠ `price` (or refund `amount` = 0) |
| 8 | `EOverRateCap` | PAYG window spend would exceed `rate_cap` |
| 9 | `EOverTotalBudget` | would exceed the mandate's lifetime `total_budget` |
| 10 | `EInsufficientAccount` | account balance < charge amount |
| 11 | `EPlanInactive` | authorizing against a deactivated plan |
| 12 | `EBadMode` | wrong charge path for the plan/mandate mode |
| 13 | `EAccountMismatch` | mandate not bound to the passed account |
| 14 | `EZeroPrice` | Fixed plan price must be > 0 |
| 15 | `EZeroInterval` | Fixed plan interval must be > 0 |
| 16 | `EZeroRateCap` | PAYG rate cap must be > 0 |
| 17 | `EZeroRateWindow` | PAYG rate window must be > 0 |
| 18 | `EZeroBudget` | mandate budget must be > 0 |
| 19 | `EBadExpiry` | expiry must be after the first chargeable time |
| 20 | `EBadChargeSeq` | metered `seq` ≠ mandate's `charge_seq` (idempotency gate) |
| 21 | `ERefundExceedsSpent` | cumulative refunds would exceed `spent_total` |
| 22 | `ENotMerchant` | refund by a non-merchant |
| 23 | `ETermsMismatch` | `expected_*` echo ≠ the plan's actual terms |
| 24 | `EOverMaxPerCharge` | single charge exceeds the user's `max_per_charge` |
| 25 | `EZeroMaxPerCharge` | `max_per_charge` must be > 0 |
| 26 | `ENotPlanMerchant` | deactivate by a non-merchant of the plan |
| 27 | `EWrongVersion` | object version ≠ package version (migrate first) |
| 28 | `EAccountNotEmpty` | `close_account` with a non-zero balance |
| 29 | `EMandateNotRevoked` | `close_mandate` before the mandate is revoked |

## Deterministic vs transient

These aborts are **deterministic** — retrying the same transaction yields the same code. The biller/keeper treat them differently from transient RPC failures:

* `EOverRateCap` / `EOverTotalBudget` / `EOverMaxPerCharge` → **carry** the remainder, not an error.
* `EBadChargeSeq` after a timeout → the charge **already landed**; re-read `charge_seq`. Never a double-charge.
* `EInsufficientAccount` → enter dunning (Fixed) / carry (PAYG); recovers when the account is funded.

See [Errors](../reference/errors.md) for handling patterns and the user-facing meaning of each.

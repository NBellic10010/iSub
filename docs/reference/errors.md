# Errors

All SDK errors derive from `IsubError`. On-chain reverts surface as `IsubAbortError` (with the Move abort code); gateway HTTP failures as `IsubHttpError`.

```typescript
import { IsubError, IsubAbortError, IsubHttpError, isIsubError, abortCodeOf, errorName } from '@isub/sdk';
```

## Classes

```typescript
class IsubError extends Error {
  code: 'move_abort' | 'http' | 'lock' | 'config' | 'usage' | 'not_found' | 'parse';
}

class IsubAbortError extends IsubError {  // code: 'move_abort'
  abortCode: number;   // the Move E* code
  digest?: string;
}

class IsubHttpError extends IsubError {   // code: 'http'
  status: number;      // HTTP status from the gateway
}
```

| `code` | Thrown when |
| --- | --- |
| `move_abort` | a transaction reverted on-chain (`IsubAbortError`, carries `abortCode`) |
| `http` | a gateway/thin-client HTTP call failed (`IsubHttpError`, carries `status`) |
| `config` | misuse / bad config (e.g. `deposit()` on a non-SUI coinType, malformed RateCard) |
| `lock` | the keeper/biller single-instance lock was lost (another instance took over) |
| `usage` | invalid usage input to the biller |
| `not_found` | an object id didn't resolve |
| `parse` | unexpected on-chain shape while parsing |

## Decoding aborts

```typescript
import { abortCodeOf, errorName, isIsubError } from '@isub/sdk';

try {
  await isub.chargeMetered(keeper, { accountId, mandateId, amount, seq });
} catch (e) {
  const code = abortCodeOf(e);            // number | null — works on IsubAbortError and raw throws
  if (code != null) console.log(errorName(code), `(#${code})`); // e.g. "EOverRateCap (#8)"
  else if (isIsubError(e)) console.log(e.code, e.message);
  else throw e;
}
```

* `abortCodeOf(e)` returns the Move abort code from an `IsubAbortError` (or by parsing a raw thrown error), else `null`.
* `errorName(code)` maps a code to its symbolic name (`ERROR_CODES`), falling back to `E<code>`.
* `isIsubError(e)` narrows to `IsubError`.

## Common aborts → user-facing meaning

| Abort | What to tell the user / do |
| --- | --- |
| `EIntervalNotElapsed` (#6) | Not due yet — wait for the interval / `notBefore`. |
| `EWrongAmount` (#7) | Fixed charge must equal `price`. |
| `EOverRateCap` (#8) | Rate limit hit — retry in the next window (the biller carries it automatically). |
| `EOverTotalBudget` (#9) | Lifetime budget reached — ask the user to re-authorize with a higher budget. |
| `EInsufficientAccount` (#10) | Account underfunded — prompt a deposit. |
| `EBadChargeSeq` (#20) | The charge already happened (or seq is stale) — re-read `chargeSeq`. Not a double-charge. |
| `EOverMaxPerCharge` (#24) | Single charge exceeds the user's per-charge cap — split it or ask to raise the cap. |
| `ETermsMismatch` (#23) | The `expected*` echo didn't match the plan — the user must re-review terms. |
| `ENotAuthorizedCharger` (#3) | Wrong signer for a metered charge — must be merchant/keeper. |

Full numeric list: [Abort codes](../contracts/abort-codes.md).

## Biller failure classification

`IsubBiller` events distinguish **deterministic** aborts (rate/budget/per-charge → carried, not an error) from **transient** failures (RPC timeouts → retried). A timed-out metered submit is repaired by `recoverOrphan` via the seq, never re-billed. See [IsubBiller](biller.md).

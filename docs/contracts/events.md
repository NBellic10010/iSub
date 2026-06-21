# Events

`isub::subscription` emits an event for every state transition. The event type filter is `<packageId>::subscription::<EventName>`. These are the source of truth for an indexer or analytics pipeline.

| Event | Fields | Emitted by |
| --- | --- | --- |
| `AccountOpened` | `account_id, owner` | `open_account` |
| `AccountClosed` | `account_id, owner` | `close_account` |
| `PlanCreated` | `plan_id, merchant, mode` | `create_plan_*` |
| `PlanDeactivated` | `plan_id` | `deactivate_plan` |
| `PlanClosed` | `plan_id` | `close_plan` |
| `MandateAuthorized` | `mandate_id, account_id, subscriber, merchant` | `authorize_*` |
| `MandateRevoked` | `mandate_id` | `revoke` |
| `MandateClosed` | `mandate_id` | `close_mandate` |
| `Charged` | `mandate_id, account_id, amount, spent_total, seq, by` | `charge` / `charge_metered` |
| `Refunded` | `mandate_id, account_id, amount, refunded_total` | `refund` |

## Notes for indexers

* **`MandateAuthorized` has no `plan_id`.** Fill it with one `getMandate(mandate_id)` point-read. (This is exactly what `IsubIndex.ingestMandate` does.)
* **`Charged` has no timestamp.** Use the transaction's checkpoint time, or read `at_ms` from your own usage/journal rows.
* **`Charged.by`** is the signer that triggered the charge (keeper/merchant for PAYG; anyone for Fixed).
* **Net spend** = `spent_total` (from the latest `Charged`) − `refunded_total` (from the latest `Refunded`).
* `seq` is the post-increment `charge_seq` — strictly increasing per mandate; a perfect reconciliation anchor.

## Why iSub also keeps a write-time index

gRPC can't enumerate **shared** objects by owner, and the SDK deliberately avoids event-scanning on the hot path (the keeper uses an explicit watch set). So for dashboards iSub maintains a write-time relationship index (`IsubIndex`) that re-derives each row from a chain point-read — see [Managed gateway & index](../guides/managed-gateway.md). An event-tail backstop (gRPC subscription + GraphQL backfill) is the documented next step for catching objects created outside iSub's own surfaces.

## Reading events

For ad-hoc reads, query by event type via Sui's GraphQL RPC (filtered historical pagination) or subscribe via gRPC `subscription_service` (push). Load the `accessing-data` skill for the exact, current API calls — don't hard-code a deprecated JSON-RPC path (JSON-RPC is being sunset).

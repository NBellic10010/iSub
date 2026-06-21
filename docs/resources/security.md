# Security model

iSub's safety comes from caps the **contract** enforces — never the merchant's backend. This page summarizes the guarantees and the residual risks.

## Guarantees (on-chain)

* **Custody stays with the user.** Only `account.owner` can withdraw. No party can move funds out of an `Account` except a charge within an active mandate's caps.
* **Every charge is bounded.** `maxPerCharge`, `rateCap`/`rateWindowMs` (PAYG), `intervalMs` (Fixed), `totalBudget`, and `expiryMs` are all checked in `settle()` / the charge guards. Breaking any aborts the transaction — no partial effect.
* **Terms can't be faked.** `authorize*` binds the user-reviewed `expected_*` to the live plan (`ETermsMismatch`), so a tampered UI or swapped plan can't authorize different terms.
* **No double-billing.** Metered charges are idempotent on `charge_seq`; a timed-out retry lands once or aborts `EBadChargeSeq`.
* **Budget is monotone.** Refunds accumulate in `refunded_total` and do **not** restore `total_budget`, so charge↔refund round-trips can't wash the cap back open.
* **Cancellation is unilateral and terminal.** `revoke` needs only the subscriber; a revoked mandate can never charge again.
* **Version-gated.** Stale objects abort (`EWrongVersion`) until migrated after a package upgrade.

## Residual risks & mitigations

| Risk | Mitigation |
| --- | --- |
| A compromised **keeper/merchant** key drains within the caps | Tight `maxPerCharge` + `rateCap` cap the slope; the user can `revoke`/`withdraw` faster than a small per-charge pull empties the account. Use a **dedicated** keeper key, never your main wallet. |
| **Over-authorization** across many mandates on one account | `accountExposure` surfaces `atRisk = min(balance, Σ remaining)` and `overAuthorized`; show it before each authorize and deposit only what's needed. |
| **UI lies** on the merchant page | Authorize in the isolated [checkout](../guides/checkout-widget.md) (iSub origin, terms read from chain) + on-chain terms-binding + optional signed consent. |
| **Phishing** an authorize for huge `totalBudget`/`expiry` | The wallet shows the bound terms; the checkout renders real on-chain values; keep budgets/expiries realistic. |
| **Indexer/gateway** compromise | The index is a **read-only projection** re-derived from chain point-reads; the keeper/biller never trust it on the hot path. It can mislead a dashboard but cannot authorize or over-charge. |

## Operational guidance

* **Dedicated keeper key.** Create plans with `keeper = <a key used only for charging>`. A plan's keeper is immutable and mandates snapshot it at authorize, so don't point it at a wallet you also hold value in. Keys live in `.secrets/<network>/` (gitignored) — never commit them.
* **Single-instance charging.** The keeper/biller take a store lock so two instances don't double-charge. Don't bypass it.
* **One db, matched port.** Run the biller and gateway against the same SQLite file, and the gateway on the port your web app expects — a mismatch only hides data, but verify it so you don't misread "no usage" as "no charge."
* **Key handling.** The SDK never needs your seed phrase; signers wrap a keypair or a wallet adapter. For automation, export a dedicated key, not your primary wallet.

## Audit posture

The Move module ships with a unit-test suite (`sui move test`) covering all the rules above, plus runnable on-chain e2e suites (`smoke`, `payg:smoke`, `pricing:smoke`, `rules:smoke`, `managed-e2e`) that assert both the happy paths and the negative guards on a live chain. Contract changes require adversarial review and a green test suite before deploy.

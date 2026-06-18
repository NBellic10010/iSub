# iSub — Security Self-Assessment Report

| | |
|---|---|
| **Project** | iSub — non-custodial recurring & metered payment primitive for Sui |
| **Scope** | `contracts/sources/subscription.move` (Account + Mandate; Fixed + PAYG; refund) |
| **Build** | Compiles under Sui CLI 1.71.1 |
| **Assessment type** | Internal adversarial self-assessment — *not* a third-party audit |
| **Date** | 2026-06-03 (initial) · 2026-06-11 (round 2: payment-infra standard) · 2026-06-13 (round 4: production hardening) |
| **Result** | 8 findings resolved · 1 tracked (open) · 1 design tradeoff accepted & mitigated · **72/72 functional + regression tests passing** |

---

## 1. Executive Summary

iSub is a contract that **pulls recurring payments on behalf of merchants**. For a contract of this class, safety is a precondition, not a feature: a single logic error can let a payee over-charge a user.

Our governing design principle is therefore: **we do not assume the merchant is honest.** We treat our own contract as the attack target and review it from the perspective of a payee attempting to extract more than authorized.

This report documents findings we identified and remediated in our own code, across two adversarial rounds:
- **Round 1 (skeleton stage):** F-01/F-02/F-03 — two security vulnerabilities and one billing-semantics defect — fixed before any real funds were at risk.
- **Round 2 (payment-infra standard):** we re-reviewed against what a production payment processor must guarantee, surfacing **F-04** (metered double-charge on retry) and **F-05** (limits defined solely by the merchant + instant drain + UI-deception vector). Both fixed.

Continued adversarial review added Medium findings across two further rounds: **M-2** (`Plan.active` dead check / no merchant deactivation) and **F-06** (terms-binding omitted the payout merchant/keeper — a plan-swap could redirect funds; this also resolved **M-3**, the implicitly-trusted keeper) are both fixed. **M-1** (rolling-window 2× burst) remains tracked-open, bounded by existing caps. One residual item (**H-2: a mandate is a revocable intent, not a guaranteed receivable**) is an inherent, accepted consequence of the non-custodial design and is mitigated rather than "fixed" (§7). The fixes are backed by a **72-test `sui move test` suite (all passing)** and validated end-to-end on localnet and Sui testnet. Formal verification and third-party audit are tracked on our roadmap (§8).

We consider surfacing our own weaknesses more trustworthy than presenting none — including, in F-05, being explicit about what our own fix does *not* achieve.

---

## 2. Scope

| In scope | Out of scope |
|---|---|
| `subscription.move` — object model, `open_account` / `deposit` / `authorize` / `charge` / `revoke` / `withdraw` / `pause` / `resume` and access control | Off-chain keeper, TS SDK, frontend |
| Economic safety invariants (caps, frequency, budget, exit rights) | Third-party dependencies; gas-station / sponsor infrastructure |

---

> **Note.** The contract was subsequently redesigned from a per-subscription escrow to an **Account + Mandate** model (funds reside in the user's reusable, withdrawable account; merchants hold revocable mandates — no per-subscription pre-funding). Findings F-01 and F-02 carried unchanged into the redesigned `charge` and parameter-validation logic; F-03 concerns the redesigned `resume`.

## 3. Methodology

1. **Invariant-based review.** We first specified the safety invariants the contract must uphold (no over-charge, no over-frequency, no charge after cancellation, escrow conservation, user can always exit), then reviewed the implementation line-by-line against them.
2. **Adversarial review.** We then assumed the merchant and its charging bot are fully malicious or key-compromised, and asked: *what is the maximum value extractable from a user, and can the user stop it?*
3. **Build & test verification.** The contract compiles cleanly under Sui CLI 1.71.1, and a 33-test `sui move test` suite (functional + regression) passes green.
4. **Stated limitations.** This is an internal self-assessment, not a third-party audit. Formal verification and a third-party audit are not yet complete (§8).

---

## 4. Severity Classification

| Severity | Definition |
|---|---|
| Critical | Direct, unconditional loss of user funds beyond authorized limits |
| **High** | Loss possible under realistic conditions or misconfiguration; a core protection can be silently disabled |
| **Medium** | A safety guarantee is broken, but loss remains bounded by user-set limits |
| Low / Informational | Best-practice, hygiene, or observability gaps |

---

## 5. Findings Summary

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| **F-01** | Unbounded charge accumulation enables single-transaction escrow drain (FIXED mode) | Medium-High | ✅ Resolved |
| **F-02** | Missing input validation; zero-valued interval/window silently disables rate limiting | High | ✅ Resolved |
| **F-03** | `pause` defers rather than exempts billing (incorrect billing semantics) | Low-Medium | ✅ Resolved |
| **F-04** | Metered charge is not idempotent — a retried bill double-charges within `rate_cap` | Medium | ✅ Resolved |
| **F-05** | Limits are merchant-defined and chargeable instantly; signature isn't bound to terms (UI-deception / plan-swap) | High | ✅ Resolved |
| **H-2** | A mandate is a revocable intent, not a guaranteed receivable; shared balance is exposed to all mandates | Accepted | ⚠️ Mitigated (by design) |
| **M-1** | PAYG rolling rate window allows ~2× `rate_cap` burst across a boundary | Low-Medium | ⬜ Tracked |
| **M-2** | `Plan.active` had no setter — dead deactivation check; merchant cannot retire a plan | Medium | ✅ Resolved |
| **M-3** | `authorized_keeper` is copied from the plan; subscriber doesn't explicitly approve it | Low | ✅ Resolved (with F-06) |
| **F-06** | Terms-binding omitted the payout merchant/keeper — a same-price plan-swap could redirect funds | Medium-High | ✅ Resolved |

---

## 6. Detailed Findings

### F-01 — Single-transaction escrow drain via charge accumulation (FIXED mode)

**Severity:** Medium-High · **Status:** Resolved

**Description.** In `charge`, the FIXED-mode branch advanced the billing cursor with `last_charged_ms += interval_ms`. Within a single Programmable Transaction Block (PTB) the on-chain timestamp `now` is constant. If a subscription was left uncharged across *N* billing intervals, the guard `now >= last_charged_ms + interval_ms` stays satisfied across *N* consecutive `charge` calls in one transaction, until the cursor catches up to `now`.

**Impact.** FIXED-mode `charge` is permissionless, so **any caller can atomically execute *N* charges in a single PTB**, draining the escrow up to `total_budget` regardless of the intended one-charge-per-interval cadence. This invalidates the guarantee that a subscriber can cancel or withdraw *between* billing periods — the user would have to act before that single transaction lands. The effective protection degrades to `total_budget + escrow`, with charge timing dictated by the payee.

**Attack scenario.** A subscription sits uncharged for *N* intervals. An adversarial payee submits one PTB containing *N* `charge` commands; each satisfies the interval guard; the escrow is drained to `total_budget` in a single transaction the subscriber cannot interrupt.

**Recommendation.** Reset the cursor to the current timestamp on each successful charge, so a second charge cannot occur within the same transaction or interval.

**Resolution.** Changed the cursor update to `last_charged_ms = now`. A second `charge` in the same PTB now fails the guard `now >= now + interval_ms`. Trade-off: missed intervals are forfeited (no arrears catch-up), which we consider acceptable and safer for a subscription model.

**Verification.** ✅ Regression tests pass — `F01-1` (two charges in one PTB → second aborts `EIntervalNotElapsed`) and `F01-2` (charge succeeds exactly once per interval).

---

### F-02 — Missing input validation disables rate limiting on degenerate parameters

**Severity:** High · **Status:** Resolved

**Description.** `create_plan_fixed`, `create_plan_payg`, and `subscribe` performed no parameter validation. Degenerate values silently disable protections:
- `interval_ms = 0` makes the FIXED guard `now >= now + 0` permanently true (no time need elapse before charging).
- `rate_window_ms = 0` causes the PAYG window to reset on every `charge` (`now >= window_start_ms + 0` is always true), nullifying `rate_cap`.
- Zero `price` / `rate_cap` / `total_budget`, or a past `expiry_ms`, similarly yield nonsensical or unsafe subscriptions.

**Impact.** A merchant — whether malicious or merely misconfiguring — can create plans that bypass rate limiting entirely, leaving only `total_budget` as a backstop (or none). Combined with F-01, this enables an immediate drain with no elapsed time, and the user receives no warning.

**Recommendation.** Validate all economic parameters at both plan creation and subscription.

**Resolution.** Added assertions: FIXED plan — `price > 0`, `interval_ms > 0`; PAYG plan — `rate_cap > 0`, `rate_window_ms > 0`; subscribe — `deposit > 0`, `total_budget > 0`, `expiry_ms > now`. Introduced dedicated error codes (12–18).

**Verification.** ✅ Regression tests `F02-1..6` pass (zero-valued or past-expiry plan creation / authorization → abort with the expected code).

---

### F-03 — `pause` defers billing rather than exempting it

**Severity:** Low-Medium · **Status:** Resolved

**Description.** While `status = PAUSED` correctly blocks `charge`, the original `resume` did not advance the billing cursor `last_charged_ms` (FIXED mode) or reset the PAYG rate window. After resuming, the interval that elapsed during the pause is immediately due, so a catch-up charge fires on resume and the paused duration is effectively billed. Because F-01 was already remediated, this is a *single* catch-up charge rather than an unbounded drain — the impact is semantic, not a drain. Users expect "pause" to mean *do not bill me for this period*, not *defer and collect on resume*.

**Impact.** Incorrect billing semantics: a paused subscriber is charged once immediately upon resume, and the paused duration is not exempted. Bounded by per-charge caps; not a fund drain.

**Recommendation.** On resume, advance the billing cursor to the current time so the paused period is exempted.

**Resolution.** `resume` now takes a `Clock` and sets `last_charged_ms = now` (FIXED — next charge is a full interval later) and resets the PAYG window (`window_start_ms = now`, `window_spent = 0`). Note: this changes the `resume` function signature (adds a `Clock` argument); off-chain callers and the SDK must pass the clock.

**Verification.** ✅ Regression tests `F03-1`/`F03-2` pass (pause → elapse intervals → resume → no immediate charge; PAYG window reset on resume).

---

### F-04 — Metered charge is not idempotent (retry double-charges)

**Severity:** Medium · **Status:** Resolved

**Description.** PAYG amounts are merchant-determined from off-chain metering, so the merchant's billing worker submits each bill as a `charge` whose amount it chooses. If that submission times out *after* landing on-chain (a routine network event), a naive worker retries — and the retry was a brand-new transaction that the contract had no way to recognize as a duplicate. Within `rate_cap`/`total_budget` it would settle a second time. FIXED mode was already idempotent (the interval gate rejects a same-period retry); PAYG had no equivalent.

**Impact.** A subscriber is charged twice for one billing period under ordinary retry conditions — the canonical failure that every payment processor closes with an idempotency key. Bounded by `rate_cap` + `total_budget`, but a real, silent over-charge.

**Recommendation.** Give metered charges an idempotency key and split them from the permissionless FIXED path.

**Resolution.** Added a monotonic `charge_seq` to each mandate (+1 per successful charge). PAYG now uses a dedicated `charge_metered(amount, seq, …)` that asserts `seq == charge_seq` (`EBadChargeSeq`); a timed-out bill is resubmitted with the *same* seq, so it either lands exactly once or aborts because the seq already advanced. The legacy `charge` is now FIXED-only (`EBadMode` on a PAYG mandate). Both paths funnel through a single private `settle()` — the one place funds move. `charge_seq` doubles as the on-chain charge counter the off-chain ledger reconciles against.

**Verification.** ✅ Tests `n1_1..n1_6` pass (seq advances; replayed seq aborts; future seq aborts; wrong-mode entries abort; FIXED also advances the counter).

---

### F-05 — Limits are merchant-defined and instantly chargeable; the signature isn't bound to the terms

**Severity:** High · **Status:** Resolved

**Description.** `price`, `interval_ms`, `rate_cap`, and `rate_window_ms` all originate from the merchant's `Plan`; the only limits a subscriber set at `authorize` were `total_budget` and `expiry_ms`. Combined with first-charge-due-immediately, this meant: (a) a merchant who set `rate_cap ≥ total_budget` (or `price ≈ total_budget`) could charge `min(total_budget, balance)` in a single transaction the instant after authorization — the rate window provides **no protection against the merchant itself**, only against a keeper deviating from the merchant's own policy; and (b) nothing tied the subscriber's signature to the terms they believed they were approving, so a merchant front-end could display "$5/mo" while the on-chain `Plan` says "$5000/period" (UI deception), or swap a cheap reviewed `Plan` for an expensive one at signing (plan-swap).

**Impact.** The amount extractable is the user-signed `total_budget` (not *beyond* what was signed — so this is not unbounded theft), but the protections a user would expect (rate limiting; a chance to react before the first charge) are absent, and the terms a user *thinks* they agreed to are not enforced. A core protection class is effectively merchant-controlled — High by our own criteria.

**Recommendation.** Bind the signature to the terms; give the user limit knobs that don't depend on the merchant.

**Resolution.** `authorize` was split into `authorize_fixed` / `authorize_metered`, each taking the user's **expected terms** as explicit arguments and asserting they equal the `Plan` (`ETermsMismatch`) — a mismatch aborts at authorization, so no mandate is created. Added a user-set `max_per_charge` (PAYG; implicitly `price` for FIXED — `EOverMaxPerCharge`) and an optional `first_charge_after_ms` review window. The function name binds the mode (`EBadMode` on the wrong plan type).

**What this fix does *not* do (stated honestly).** None of these *stop* an authorized merchant from charging — a pull primitive that could would not be one. Specifically:
- `max_per_charge` caps the *per-charge slope*, **not the lifetime ceiling** — the worst case is still `total_budget` extracted over time. Its real value is converting an instant drain into a paced one, buying time for the kill-switches below.
- `first_charge_after_ms` only *delays* the first charge.
- terms-binding defeats UI-deception / plan-swap **only if** the `expected*` values are sourced from a surface the merchant doesn't control (a neutral checkout widget or a wallet rendering on-chain `Plan` via `sui::display`) — **not** auto-read from the same `Plan` being authorized, which would make the assertion a tautology. Our SDK therefore requires `expected*` to be passed explicitly and offers `quoteFromPlan` for *display only*, never as an auto-fill. A trusted display path (`sui::display`) is the dependent P1 item.

The mechanisms that actually *stop* a merchant are unchanged and pre-existing: `revoke` (terminal), `withdraw` / `withdraw_all` (starve the account), `expiry_ms`, and `total_budget` exhaustion. The honest security story is **bounded and revocable trust, not absent trust.**

**Verification.** ✅ Tests `h1_1..h1_10` pass (terms mismatch × mode; wrong-mode entry; zero/over `max_per_charge`; first-charge window blocks then allows; `not_before ≥ expiry` rejected; FIXED `max_per_charge == price`).

---

### M-2 — `Plan.active` had no setter (dead deactivation check; merchant cannot retire a plan)

**Severity:** Medium · **Status:** Resolved

**Description.** `active` was set `true` at plan creation and never mutated, so the only reader — `assert!(plan.active)` in `authorize` — was unreachable (`EPlanInactive` could never fire) and a merchant had no way to stop new subscriptions to an outdated plan.

**Impact.** Functional gap plus a misleading field and an auditor-visible dead branch. No fund risk.

**Resolution.** Added `deactivate_plan` (merchant-only, one-way; `ENotPlanMerchant`, `PlanDeactivated` event). It blocks only *new* `authorize` calls — existing mandates snapshot their terms and keep running (snapshot principle). `EPlanInactive` is now reachable.

**Verification.** ✅ Tests `m2_1..m2_3` (deactivate → new authorize aborts `EPlanInactive`; non-merchant deactivate aborts `ENotPlanMerchant`; existing mandate still chargeable after deactivation).

---

### F-06 — Terms-binding omitted the payout merchant (and keeper); a plan-swap could redirect funds

**Severity:** Medium-High · **Status:** Resolved · *(self-review finding; F-05 was incomplete)*

**Description.** F-05 bound the subscriber's signature to `price`/`interval` (Fixed) and `rate_cap`/`rate_window` (PAYG) — but **not** to `plan.merchant` (the payout recipient) or `plan.keeper` (the PAYG authorized charger), both of which were copied from the plan unchecked. So a hostile front-end (F-05's own threat model) could substitute a same-price/interval plan whose `merchant` is the attacker: the price/interval echo matches, terms-binding passes, and the resulting mandate pays the attacker. F-05 therefore defeated price/interval-swap but **not merchant-swap** — and the merchant is the most consequential term (who gets the money).

**Impact.** Under a malicious UI, payments are redirected to an attacker-controlled merchant at the agreed price/interval, bounded by `total_budget`. Not over-charge beyond limits, but a fund-redirection that the fix specifically claimed to prevent. This finding also subsumes **M-3** (the keeper was likewise unbound).

**Resolution.** `authorize_fixed` now takes `expected_merchant` and asserts `plan.merchant == expected_merchant`; `authorize_metered` takes `expected_merchant` **and** `expected_keeper` and asserts both (reusing `ETermsMismatch`). Keeper is not bound for Fixed (its `charge` is permissionless, so the keeper field carries no access-control meaning there). The same trusted-display caveat as F-05 applies: `expected_*` must originate from what the user reviewed, not be auto-read from the plan being authorized.

**Verification.** ✅ Tests `r1_1` (Fixed merchant mismatch → abort), `r1_2` (PAYG merchant mismatch → abort), `m3_1` (PAYG keeper mismatch → abort), `r1_3` (all-correct terms → success, no false reject).

---

### Open findings — tracked, not yet remediated

One remains, bounded by existing protections.

- **M-1 — Rolling-window 2× burst · Low-Medium · open.** The PAYG rate window resets `window_start = now` on expiry, so a payee can charge `rate_cap` just before a boundary and again just after — ~2× `rate_cap` in a short real interval. Bounded by `total_budget` (lifetime) and the user's `max_per_charge` (per charge); since `rate_cap` is merchant-defined and not a user protection against the merchant itself (F-05), user impact is limited. Note: a fixed/tumbling window does **not** remove the boundary burst — the correct fix for a hard "≤ `rate_cap` over any window" guarantee is an O(1) token bucket (continuous refill). Deferred pending whether `rate_cap` is meant as a hard throughput ceiling or merchant-side pacing.

*(M-3 — implicitly-trusted keeper — was resolved together with F-06: `expected_keeper` is now bound at authorization.)*

---

## 7. Known Limitations & Residual Risks

We are explicit about what on-chain enforcement does *not* cover:

| Item | Assessment |
|------|-----------|
| **H-2a — Mandate ≠ guaranteed receivable (service non-delivery)** | The chain guarantees a payee cannot charge beyond user-set caps and that the user can revoke and reclaim unused funds at any time — but it cannot guarantee the merchant delivers, nor that a `charge` succeeds (the user may have withdrawn). A mandate is a **revocable intent, not a guaranteed receivable**; merchant integration docs state this explicitly. Loss to the user is bounded by `total_budget`; merchant bad-debt is bounded to ≈ one billing period (a failed charge gates service in real time — a *better* risk profile than net-30 invoicing). **Mitigations now in place:** the off-chain billing state machine (`active → past_due → recovered | lapsed` with events) operationalizes failed charges; a `refund` primitive (returns funds into the Account) is the base layer under future dispute escrow. **Roadmap:** usage attestations → dispute window → bonded/arbitrated escrow + tiered settlement (architecture §7.7–§7.8). |
| **H-2b — Shared-balance exposure** | One reusable `Account` backs many Mandates, pulled first-come-first-served, so the balance is simultaneously exposed to every active mandate up to its remaining budget. This is the cost of the "fund once, manage all subscriptions" design. **Mitigation:** the SDK's `accountExposure()` computes Σ remaining authorization vs balance; wallets/checkout must surface total exposure *before* each `authorize`. (Concurrent charges also serialize via consensus on the shared object — a throughput note at scale, not a safety issue.) |
| **PAYG usage reporting** | Usage is reported by the merchant. The chain bounds loss via `rate_cap` / `total_budget` / user `max_per_charge`, but trusts the reported figure within those bounds — analogous to trusting a Web2 metered bill. Mitigation (usage attestations / dispute window) is on the roadmap, and is the prerequisite for any merchant-slashing (architecture §7.8). |
| **Merchant misbehavior (general)** | Already-pulled funds are final and unrecoverable on-chain — so punishment must be pre-positioned (bond/slash), settled-late (delayed settlement / dispute), or off-chain (reputation, identity/legal). The contract deliberately holds **no admin key to seize or freeze a merchant** (symmetric with not freezing users — neutrality is the reason merchants can trust it). Tiered scheme in architecture §7.8. |
| **Withdraw-to-exit** | A subscriber may withdraw from their Account ahead of a due charge to avoid it. This is the **intended non-custodial exit right**, not a defect. |
| **Storage reclamation** | Revoked/expired `Mandate` shells persist; a `close` entrypoint to reclaim the storage rebate is tracked. |

---

## 8. Remediation & Verification Status

| Item | Status |
|------|--------|
| Contract compiles (`sui move build`) | ✅ Passing |
| Functional + regression suite (F-01…F-06, M-2 + §7.4 invariants + access control + version/lifecycle) | ✅ 72/72 passing (`sui move test`) |
| End-to-end validation on localnet **and Sui testnet** (lifecycle + keeper + PAYG idempotency/refund + dunning/reconciliation) | ✅ 19 + 7 + 16 + 12 assertions green on both networks |
| Upgrade safety — version gate on all shared objects + permissionless one-way `migrate_*`; object reclaim (`close_*`) | ✅ Added (round 4); `version` field in place before mainnet freeze |
| Formal verification of safety invariants (Sui Prover) | ⬜ Roadmap |
| Third-party audit | ⬜ Roadmap |

---

## 9. Revision History

| Date | Change |
|------|--------|
| 2026-06-03 | Initial skeleton compiles |
| 2026-06-03 | **F-01 fixed** — `charge` FIXED branch: `last_charged_ms += interval_ms` → `last_charged_ms = now` |
| 2026-06-03 | **F-02 fixed** — input validation added at plan creation and subscription; error codes 12–18 |
| 2026-06-03 | Redesigned to **Account + Mandate** model — no per-subscription pre-funding |
| 2026-06-03 | **F-03 fixed** — `resume` advances the billing cursor to `now`; pause now exempts rather than defers |
| 2026-06-08 | **Functional + regression suite added** — 33 tests, `sui move test` all green; no new findings |
| 2026-06-11 | **Round 2 (payment-infra standard).** **F-04 fixed** — metered idempotency via `charge_seq` + dedicated `charge_metered(seq)`; `settle()` single exit; FIXED/PAYG charge paths split. Added `refund` primitive (returns funds to the Account; gross-monotone budget). |
| 2026-06-11 | **F-05 fixed** — `authorize` split into `authorize_fixed`/`authorize_metered` with explicit expected-terms binding (`ETermsMismatch`), user-set `max_per_charge`, and `first_charge_after_ms`. Wrong narrative ("rate_cap is a user safety valve") corrected in architecture §1.5/§7.4. |
| 2026-06-11 | **H-2 accepted & mitigated** — billing state machine (dunning/recovery), `accountExposure()` SDK helper, merchant-integration docs; merchant-misbehavior punishment tiers documented (architecture §7.8). |
| 2026-06-11 | **Suite → 55 tests**, all green on `sui move test`; full e2e validated on localnet and Sui testnet. |
| 2026-06-11 | **Round 3 (continued adversarial review).** **M-2 fixed** — `deactivate_plan` (merchant-only, one-way); error 26 `ENotPlanMerchant`; `PlanDeactivated` event; `EPlanInactive` now reachable. **M-1 / M-3 logged as tracked-open.** Suite → **58 tests**, all green. |
| 2026-06-11 | **Production hardening.** Object `version` gate + permissionless `migrate_*` (upgrade safety, error 27); `close_account`/`close_mandate`/`close_plan` (storage-rebate reclaim, errors 28/29). Suite → **68 tests**, all green. |
| 2026-06-11 | **Round 4 (terms-binding completeness).** **F-06 fixed** — `authorize_fixed`/`authorize_metered` now bind `expected_merchant` (and `expected_keeper` for PAYG), closing the merchant/keeper plan-swap gap; **resolves M-3**. Suite → **72 tests**, all green. |
| 2026-06-13 | **Round 4 (production hardening — not findings).** Added **version gate** (`version` field on all shared objects + per-entry check + permissionless one-way `migrate_*`; errors 27) — the pre-mainnet window for the struct-frozen field — and **object reclaim** (`close_account`/`close_mandate`/`close_plan`, errors 28/29; storage-rebate). Suite → **68 tests**, all green; e2e smoke now exercises close (19 assertions). |

---

*Prepared as an internal self-assessment by the iSub team. We audited our own payment contract adversarially — first at the skeleton stage, then against a production payment-infrastructure standard — and remediated five real issues before mainnet. Where a finding is an inherent tradeoff of non-custodial design (H-2), we say so and mitigate rather than pretend to fix; where our fix has limits (F-05), we state exactly what it does not do. For a contract that collects money on someone's behalf, that honesty is the baseline, not a performance.*

# Interface Decision: x402/AP2 — Separate Interface or Adapt Existing?

**Status:** Decided. **Date:** 2026-06-21.
**Question:** To accept third-party agents via x402 + AP2, do we break the existing
charge/billing interface, and should we build a SEPARATE interface or adapt the existing one?

**Decision (one line):** **Option C — build x402/AP2 as an ADAPTER/FACADE shell that wraps
the unchanged `IsubService.use()/useMetered()` core.** Existing callers are untouched;
everything new is additive, layered exactly like `mcp.ts` and `gateway.ts` already are.

---

## What "the existing interface" actually is (verified against source)

The billing/settlement surface is cleanly layered and the agent-facing chokepoint is *narrow*:

- **Agent-facing entry** — `IsubService.use(mandateId, amount, usageId, proof?)` and
  `useMetered(mandateId, items, usageId, proof?)`, both returning
  `UseResult {ok, status, reason}`. The `status` is a load-bearing tri-state:
  **200 served / 402 budget-gated / 403 bad credential** (plus 400 bad input, 500 no rate card).
  `service.ts:38-42` (UseResult), `service.ts:99` / `service.ts:127` (entries).
- **The chokepoint is a one-method structural slice** — `MeteredService { use(...) }` at
  `mcp.ts:35-38`. `IsubService` satisfies it *structurally*; `mcp.ts` depends only on this
  slice, never on the concrete runtime. This is the seam a new protocol adapter consumes.
- **Settlement is ACCRUE-then-BATCH-FLUSH, never per-call.** `use()` calls
  `biller.recordUsage(...)` then returns 200 on accrual; the on-chain `charge_metered`
  fires later on the window loop or a best-effort threshold flush (`service.ts:108-118`).
- **`flush(mandateId?) -> FlushResult[]`** is already exposed and returns the digest
  (`biller.ts:251`), re-exported through the gateway (`gateway.ts:118-120`).
- **The hard-won correctness lives in the biller**: usageId dedup at ingest, `charge_seq`
  monotonicity, `recoverOrphan` reconciliation at the top of every settle, price FROZEN at
  ingest, and the single-biller-per-mandate lock (`biller.ts:10-17`, `biller.ts:391-425`,
  `biller.ts:50/230`, `biller.ts:268-283`). **This is the code we must not duplicate.**
- **Five clean extension seams already exist** (BillerChain, BillerStore, the `proof?`/
  CallProof PoP layer, the `onEvent` callback, and the MeteredService slice) — the codebase
  is pre-shaped to *absorb* an adapter without edits to `service.ts`/`biller.ts`/`client.ts`.
- **HTTP routing is a flat `if (startsWith(...))` dispatcher** (`gateway.ts:130-252`); new
  `/x402/*` routes are an additive branch that funnels into the existing in-process
  `use()/useMetered()`, which already thread `proof?` end-to-end (`gateway.ts:101-113`).

The one genuine conflict to design around (independent of which option we pick): **x402 is
SYNCHRONOUS per-call** — its HTTP response must confirm on-chain payment — while `use()`
returns 200 on *accrual*. Resolution: the adapter calls `recordUsage` then `await
flush(mandateId)` for that single mandate to obtain a digest for the `exact` scheme, and
maps `upto` onto the frozen-price `useMetered` path. The `flush` primitive for this already
exists; no new settlement code is required.

---

## The three options

### (A) Invasively reshape `IsubService`/`IsubBiller` to be x402-shaped

Make the core natively speak PaymentRequirements / X-PAYMENT and settle synchronously per call.

**Pros**
- One "blessed" path; no facade indirection.
- The synchronicity mismatch is resolved in exactly one place.

**Cons**
- **Breaks existing callers.** `mcp.ts`, `gateway.ts`, and `service.listen()` all consume
  the current `use()` contract and the 200/402/403 tri-state. Reshaping return types or
  making `use()` settle-per-call changes behavior for every existing caller and invalidates
  the existing smokes.
- **Double-billing risk: HIGH.** Forcing synchronous settlement into the hot path means the
  request path and the window/threshold flush loop can both try to settle the same mandate.
  The orphan-recovery correctness explicitly *assumes one biller per mandate*
  (`biller.ts:399-400`); two settle triggers against one mandate is precisely the condition
  it is not designed for. You would be modifying the most dangerous file in the system.
- **Destroys the batch-aggregation property** that "keeps micro-metering viable on-chain"
  (`biller.ts:6-8`): every call now awaits an on-chain tx + gas.
- **Idempotency/orphan-recovery REUSE: forced rewrite in place.** You are editing the exact
  code (`recoverOrphan`, `charge_seq` gating, the single-flight/lock) whose correctness was
  hard-won — the highest-blast-radius place to introduce a money bug.
- **Testability: worsens.** The current biller is "fully unit-testable with no chain"
  (`biller.ts:19-20`); coupling settlement to a synchronous HTTP response path entangles it
  with transport.
- **Maintenance: worst.** One overloaded interface serving two protocols with different
  timing semantics.

**Verdict: reject.** Highest breakage, highest double-billing risk, edits the riskiest code.

### (B) Fully PARALLEL / separate billing interface for x402/AP2

A second, independent billing+settlement stack alongside the existing one.

**Pros**
- Existing callers untouched (the *only* shared property with C).
- x402/AP2 can be designed to spec with zero compromise to its own timing model.

**Cons**
- **Code duplication: severe — and in the worst possible place.** A parallel settlement
  stack means a **second implementation of dedup + `charge_seq` monotonicity +
  `recoverOrphan` + price-freeze + the single-biller lock.** That is *a second place for
  every money bug to live*, and the two implementations will drift.
- **Double-billing risk: HIGH and structural.** Two independent billers settling the *same
  on-chain mandate* (same `charge_seq`, same account) outside one shared lock directly
  violates the single-biller-per-mandate invariant (`biller.ts:268-283`, `biller.ts:399-400`).
  The on-chain `charge_seq` is global to the mandate; two off-chain settlers racing it is the
  canonical double-charge scenario.
- **Idempotency/orphan-recovery REUSE: ZERO.** This is the option that duplicates all of the
  hard-won logic. Every invariant (G1 money-correctness, the journal membership rule, the
  lease-based cross-instance lock) must be re-derived and re-tested.
- **Testability: doubles the surface.** Two stacks, two sets of crash/lost-ack/orphan tests.
- **Maintenance: worst long-term.** Every future billing fix must land twice.

**Verdict: reject.** This is the explicit anti-goal: duplicating the idempotency/orphan-
recovery/price-freeze logic creates a second home for money bugs.

### (C) ADAPTER / FACADE over the existing interface  ✅ RECOMMENDED

Ship `@isub/sdk/x402` (and an AP2 resolver) as a node-only shell — a sibling to `mcp.ts`
and `gateway.ts` — that consumes the unchanged `MeteredService` slice and translates
protocol shapes. Existing callers unchanged; everything new is additive.

**Pros**
- **Breaks existing callers: NONE.** The adapter consumes `use()/useMetered()` as-is. The
  `proof?` arg is optional and `agentAuth` defaults to `'off'` (`service.ts:84`), so adding a
  proof-carrying x402 caller changes nothing for current callers; existing smokes pass.
- **Double-billing risk: LOW.** All settlement still flows through the *one* biller behind
  the single-biller-per-mandate lock. The adapter triggers settlement only via the existing
  `flush(mandateId)` primitive (`biller.ts:251`), which is itself per-mandate single-flight
  (`flushOne`, `biller.ts:268-283`) — so the synchronous x402 path and the window loop
  serialize against each other instead of racing.
- **Code duplication: MINIMAL.** The adapter is a pure response-shape transform: a 402
  `UseResult` → `PaymentRequirements` body; a 200 → execution response. The status contract
  is *already x402-shaped* (402 = Payment Required). No billing logic is copied.
- **Idempotency/orphan-recovery REUSE: TOTAL.** Dedup, `charge_seq`, `recoverOrphan`,
  price-freeze, and the lock are reused verbatim — **there is no second copy of any of it.**
  This is the decisive criterion: C is the only option with zero duplication of the money-
  correctness core, so it adds zero new places for a money bug.
- **PoP maps 1:1, no new crypto.** `proofFromFields()` is the single shared reconstruction
  point already used by `mcp.ts`/`gateway.ts`/`service.listen()` (`agent-auth.ts:117-126`);
  an X-PAYMENT header maps onto `{agentSig, agentSigNotAfter, agentCert}` and reuses it. The
  subscriber-signed `AgentCert` (bind) = AP2 Intent Mandate; the per-call `callMessage`
  signature = x402 X-PAYMENT / AP2 Cart Mandate. `consent.ts` is already the AP2 VC envelope.
- **Testability: best.** The adapter is unit-tested against a mock `MeteredService` exactly
  as `mcp.ts` is; the biller's crash/orphan suite is untouched and still covers the money path.
- **Maintenance: best.** New subpath export (`@isub/sdk/x402`) mirroring the existing layered
  shells (`index.ts:18-23`); billing fixes land once, in the core, and both protocols inherit.
- **Non-custody preserved.** PaymentRequirements are *derived from the on-chain mandate*
  (`payTo = mandate.merchant`, `asset = coinType`, `maxAmountRequired <= spendableNow`), not
  from adapter state — charges can only land within contract caps to the merchant.

**Cons (and mitigations)**
- **Synchronicity mismatch must be bridged in the adapter.** For `exact`, accrue via
  `recordUsage` then `await flush(mandateId)` to return a digest in-band. Mitigation: the
  `flush(mandateId)` primitive already exists and returns the digest; the inline flush is
  per-mandate single-flight, so it does not break the no-double-bill invariant. Cost: that one
  x402 call pays an on-chain tx + gas (acceptable — it is x402's required semantics, and only
  x402 callers opt into it; legacy accrue-batch callers are unaffected).
- **`agentAuth` is a single per-service flag, not per-route.** An x402 caller needs
  `'enforce'` while a legacy caller may be `'off'`; one `IsubService` instance can't express
  both (`service.ts:35/84`, `gateway.ts:69-77`). Mitigation: run a *separate IsubService
  instance* (or per-tenant gateway service) for the x402 surface with `agentAuth:'enforce'` —
  cheap because the service is an embeddable runtime over the shared biller/store; it does not
  fork billing. This is a config split, not a code split.
- **`maxAmountRequired` vs RateCard price could diverge.** Mitigation: make the on-chain
  mandate + RateCard the single source of truth — route `exact` through
  `recordUsage(amount = maxAmountRequired)` and `upto` through `useMetered` only when the
  RateCard prices both the 402 challenge and the charge.

**Verdict: adopt.**

---

## Decision matrix

| Criterion | (A) Reshape core | (B) Parallel stack | (C) Adapter/facade |
|---|---|---|---|
| Breaks existing callers | **Yes** (contract + behavior) | No | **No** |
| Double-billing risk | High (two triggers, one mandate) | **High** (two billers, one `charge_seq`) | **Low** (one biller, shared lock + single-flight flush) |
| Code duplication | Rewrites core in place | **Severe** (2nd settlement stack) | **Minimal** (response-shape transform) |
| Idempotency/orphan REUSE | Forced edit of riskiest code | **Zero** (full re-implement) | **Total** (verbatim, one copy) |
| Testability | Worse (settlement entangled w/ transport) | Doubled surface | **Best** (mock slice; core suite untouched) |
| Maintenance | Worst (one overloaded interface) | Worst (every fix twice) | **Best** (additive subpath; fix once) |

---

## Where each option would DUPLICATE the hard-won logic (the key risk lens)

The money-correctness core is: **usageId dedup + `charge_seq` monotonicity + `recoverOrphan`
reconciliation + price-freeze-at-ingest + single-biller-per-mandate lock** (`biller.ts`).

- **(A)** does not copy it — it *edits it in place* under new synchronous-settlement timing,
  which is arguably worse: it perturbs the exact invariants in the one file proven correct.
- **(B)** **fully duplicates it.** A parallel settlement stack is a second, drift-prone
  implementation of every one of those invariants — the explicit anti-goal.
- **(C)** **duplicates none of it.** The adapter calls `recordUsage`/`useMetered`/`flush`
  and reuses the single biller wholesale. Zero new places for a money bug.

This lens alone selects **C**.

---

## Recommendation

Build the x402/AP2 integration as **Option C: an additive adapter/facade shell**
(`@isub/sdk/x402` + an AP2 resolver), sibling to `mcp.ts`/`gateway.ts`, consuming the
unchanged `MeteredService` slice. **Do not modify `service.ts`, `biller.ts`, or `client.ts`.**

Concretely:
1. New subpath export `@isub/sdk/x402` mirroring the existing layered shells (`index.ts:18-23`).
2. New `/x402/verify` and `/x402/settle` (and an AP2 cart endpoint) as additive branches in
   the gateway dispatcher, ordered most-specific-first (`gateway.ts:148` ordering trap), each
   funneling into the in-process `use()/useMetered()` that already thread `proof?`.
3. **402 → PaymentRequirements** and **200 → execution response** as a pure response-shape
   transform; derive PaymentRequirements *from the on-chain mandate* (non-custody).
4. **Synchronicity:** `exact` = `recordUsage` then `await flush(mandateId)` for the digest;
   `upto` = `useMetered` (frozen-price), RateCard as the single source of truth for both the
   402 challenge and the charge.
5. **PoP:** reuse `proofFromFields()` + `verifyCallProof`; map X-PAYMENT onto CallProof, the
   bind cert onto AP2 Intent Mandate, `consent.ts` as the AP2 VC envelope.
6. Run the x402 surface on its own `IsubService` instance with `agentAuth:'enforce'` over the
   **shared** biller/store (config split, not a billing fork).
7. Persist PaymentPayload / Cart Mandate / settlement digests via a new `BillerStore`-backed
   table following the `db.ts` `addColumnIfMissing` migration + `sql-store.ts` factory pattern.

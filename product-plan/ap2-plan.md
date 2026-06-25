# iSub × AP2 (Agent Payments Protocol) — adapter plan

*Self-contained spec for another session to build. Date: 2026-06-21.*

## STATUS — DESIGN LOCKED · BUILD NOT STARTED (execution plan added 2026-06-21, post-x402)

Today iSub is **AP2-aligned** (its on-chain `Mandate` is the same shape AP2 standardizes) but ships **no AP2 adapter**. This plan turns "aligned" into a demonstrable **AP2-compatible** integration: accept AP2's Intent / Cart / Payment mandates, verify their signatures, map them onto iSub's `authorize*` / `chargeMetered`, and settle over the **x402 rail iSub already implements** (`src/x402.ts`, `mandate` scheme).

Honesty bar (same one we hold x402 to): claim **"AP2-compatible, interoperable by shape"** — not a certified Google integration — until we've tested against official AP2 reference samples. No Move/contract changes: this is a pure SDK adapter over existing primitives.

---

## EXECUTION PLAN (updated 2026-06-21 — the foundation is now built)

> Companion docs: **design/mapping** = the rest of this file (§0–§8); **how to bolt on without breaking billing** = [`ap2-x402-interface-arch.md`](ap2-x402-interface-arch.md) (the adapter-module decision + the small `IsubService` surface additions). This section is the actionable sequence.

### A. What changed since this plan was first written (the rail is real now)
The original plan assumed x402 "already implemented" as a premise. As of today it's **built, wired, and proven** — so AP2 Phase 2 no longer starts from zero:
- **x402 `mandate` scheme is live** (`src/x402.ts`): seller `buildPaymentRequirements`, buyer `createMandatePayment`/`payViaX402`, `MandateFacilitator.verify`/`settle`. Proven by `x402:smoke` (13 ✓), `x402-agent:smoke` (8 ✓), and a **real testnet `charge_metered`** via the Claude-CLI demo.
- **agent-auth PoP is hardened** (F1–F5, this session): verbatim-replay → 409 single-use, **durable** cert-version rollback floor (`agent_cert_vers`), bounded cert TTL (no never-expire). **AP2's Payment Mandate maps onto exactly this PoP path, so the AP2 adapter inherits all four fixes for free** — proven by `agent-auth:redteam` (9 ✓) + `agent-auth:durable` (5 ✓).
- **One service serves human + agent routes** via per-route `authMode` — the AP2 adapter is just another `'enforce'` caller of the same `IsubService`, no second settlement stack.

### B. The one decision the original plan left open — which x402 scheme to speak to AP2
AP2's crypto rail is the **a2a-x402 extension** (`github.com/google-a2a/a2a-x402`, v0.2 Apr 2026, production-ready). Its **default scheme is `exact`** — the buyer signs a one-shot stablecoin **transfer** (push). iSub's scheme is **`mandate`** — a proof-of-possession that pulls within a standing, capped, on-chain mandate. They are not the same shape:

| | `exact` (AP2 reference default) | `mandate` (iSub) |
|---|---|---|
| Money flow | buyer **pushes** a signed transfer | service **pulls** within caps (`charge_metered`) |
| Per call | fresh wallet signature each time | one cert + per-call PoP; recurring/metered |
| iSub today | **GAP** (iSub is pull-only) | **built** |

**Decision: support both, lead with `mandate`.**
- **`mandate`** is the differentiated, enforced path — recommend it to any AP2-aware counterparty (interop by shape via the x402 scheme field). This is the demo headline: *"AP2 intent → on-chain-enforced capped pull, not just an attested transfer."*
- **`exact`** is the interop courtesy: a minimal handler so an **off-the-shelf** AP2 a2a-x402 agent can settle on Sui through iSub. Honest caveat: `exact` is **push**, so it sits OUTSIDE the mandate/biller core — it needs a small buyer-signed Sui transfer builder (a new tx path), and it gives up iSub's enforcement edge. Build it for interop demos only; never present it as our model.

### C. Build sequence (files · order · gate)
1. **Phase 1 — `mandate`-scheme AP2 adapter (MVP, ~1 session, earns "AP2-compatible").**
   - `src/ap2.ts`: `Ap2IntentMandate`/`Ap2CartMandate`/`Ap2PaymentMandate` types; `verifyAp2Mandate` (reuse `agent-auth.ts` + `consent.ts`, accept by shape); `intentToAuthorize(intent, reviewedPlan)` → `authorizeMetered`/`authorizeFixed` params (terms-bound); `cartToCharge(cart, mandate)` → assert `cart.total ≤ spendable`; `executeAp2({intent?, cart, facilitator})` → verify → authorize → settle through the **existing** `MandateFacilitator` (`'enforce'`).
   - Surface additions per [`ap2-x402-interface-arch.md`](ap2-x402-interface-arch.md): the few **additive** `IsubService` methods it names (e.g. expose `spendable()`; widen `flush` return — already done this session). No existing caller changes.
   - `scripts/ap2-smoke.ts` + `npm run ap2:smoke` (mock chain, real Ed25519): Intent→authorize→Cart→settle, plus 4 negatives (over-cap, expired intent, wrong merchant `ETermsMismatch`, replayed cart `EBadChargeSeq`). **Gate: green → flip the badge `AP2-aligned` → `AP2-compatible`.**
   - `package.json` export `"./ap2": "./src/ap2.ts"`; add `ap2.ts` to the `NODE_SHELLS` allowlist in `unit.ts` if it imports `node:*` (it shouldn't need to).
2. **Phase 2 — a2a-x402 interop (~1 session, earns "settles AP2 a2a-x402 on Sui").**
   - Clone an official a2a-x402 reference Intent→Cart→Payment flow; settle it on Sui **testnet** through iSub. Add the minimal **`exact`** handler (decision B) so a vanilla AP2 agent works. A2A-shaped agent-to-agent handoff sample.
3. **Phase 3 — conformance.** Exact VC/JWT serialization per AP2 v0.2; DID ↔ Sui-address mapping; interop test vs the official a2a-x402 reference samples; USDC `<T>` carts on mainnet.

### D. EXISTS vs GAP (today)
| Piece | Status |
|---|---|
| On-chain enforced mandate (caps/expiry/revoke) — *the thing AP2 only attests* | **EXISTS** |
| x402 `mandate` rail + `MandateFacilitator` + hardened PoP (F1–F5) | **EXISTS** |
| Terms-binding (`ETermsMismatch`) + audit events (`MandateAuthorized`/`Charged`) | **EXISTS** |
| `src/ap2.ts` adapter (Intent/Cart/Payment ↔ authorize/charge) | **GAP — Phase 1** |
| `exact`-scheme push handler (vanilla AP2 interop) | **GAP — Phase 2, decision B** |
| VC/JWT exact serialization + DID mapping + official-sample interop | **GAP — Phase 3** |

## 0. Why AP2, and why iSub fits

AP2 is an open protocol (Google + Coinbase + 60org, Sep 2025), an extension to A2A (Agent2Agent), that makes AI-agent commerce trustworthy through **cryptographically-signed mandates** delivering three properties: **authorization** (the user really approved), **authenticity** (the merchant gets a genuine request), and **accountability** (a non-repudiable trail). It is payment-method agnostic — cards, bank transfers, and **crypto via the A2A x402 extension**.

The fit, in one line: **AP2 mandates are attestations; iSub mandates are on-chain enforcement of exactly that attestation.** AP2 says "the user authorized ≤ X to merchant M until T"; iSub makes that an object the chain *enforces* (capped, revocable, non-custodial). And AP2's crypto rail is x402 — which iSub already speaks. So iSub is a natural **AP2 payment-execution + settlement layer on Sui**.

## 1. AP2 constructs we must support

| AP2 mandate | Carries | iSub plays |
| --- | --- | --- |
| **Intent Mandate** | price cap, time window, merchant allowlist, item spec, "prompt playback" (NL summary of intent). Delegated / agent-not-present. | the standing authorization |
| **Cart Mandate** | exact items + final price; the user's final approval ("pay for what you see"). Human-present / confirmed. | the exact charge |
| **Payment Mandate** | authorizes a specific payment instrument; shared with Credential Provider, Networks, Merchant Payment Processor. | the rail + settlement |

AP2 roles: user · shopping agent · merchant (agent) · **Credential Provider** · **Merchant Payment Processor** · Networks. iSub claims the **Credential Provider + Merchant Payment Processor + settlement** roles — not the shopping/merchant agent.

## 2. Mapping AP2 → iSub (the core thesis)

| AP2 | iSub primitive | Mapping |
| --- | --- | --- |
| Intent Mandate · price cap | `totalBudget` + `maxPerCharge` | lifetime ceiling + per-charge throttle |
| Intent Mandate · time window | `expiryMs` (+ `firstChargeAfterMs`) | hard stop + delayed first charge |
| Intent Mandate · merchant allowlist | `expectedMerchant` / `expectedKeeper` (terms-binding) | chain aborts `ETermsMismatch` on mismatch |
| Intent Mandate · rate / recurring | `rateCap` / `rateWindowMs` (PAYG) or `price`/`intervalMs` (Fixed) | recurring + metered, which a stock AP2 cart can't express |
| Intent Mandate · prompt playback | `consent.ts` signed consent (`signPersonalMessage`) | the human-readable intent the user signs |
| Cart Mandate · exact total | one `chargeMetered(amount, seq)` (or Fixed `authorize`+`charge`) | assert `cartTotal ≤ caps`; amount == cart total |
| Cart Mandate · final approval | the consent signature + terms-binding | "pay for what you see" enforced on-chain |
| Payment Mandate · instrument auth | x402 `mandate`-scheme `X-PAYMENT` payload (PoP) → `MandateFacilitator.settle()` | the single on-chain `charge_metered` |
| Accountability / audit | `MandateAuthorized` / `Charged` / `Refunded` events | non-repudiable, public, on-chain |
| Authenticity | terms-binding + `agent-auth.ts` proof-of-possession | merchant gets a genuine, bound request |

### Our value-add over a stock AP2 implementation
- **Enforcement, not just attestation.** A forged or compromised agent still can't exceed the on-chain mandate's caps.
- **Non-custodial + revocable.** Funds stay in the user's `Account`; `revoke` / `withdraw` any time.
- **Recurring + metered.** An AP2 Intent over iSub becomes a *standing capped subscription*, not a single cart.

## 3. Scope — what to build

### Module `@isubpay/sdk/ap2` (`src/ap2.ts`)
- **Types** (compatible shapes; u64s as decimal strings): `Ap2IntentMandate`, `Ap2CartMandate`, `Ap2PaymentMandate`, `Ap2VerifyResult`.
- `verifyAp2Mandate(m, opts)` — verify the signature/credential. Reuse `agent-auth.ts` (PoP) + `consent.ts`; accept JWS/VC **by shape** (don't hard-fail on spec drift; record the format).
- `intentToAuthorize(intent, plan)` — map an Intent Mandate → `authorizeMetered` / `authorizeFixed` params, sourcing `expected*` from the plan the user reviewed (terms-binding, not a tautology — see `trusted-display`).
- `cartToCharge(cart, mandate)` — map a Cart Mandate → `chargeMetered` args (`amount`, `seq`); assert `cart.total ≤ spendable(mandate)`.
- `executeAp2({ intent?, cart, ... })` — full flow: verify → `authorize` (if no mandate yet) → settle via the x402 `MandateFacilitator` / biller.
- **x402 bridge**: an AP2 Payment Mandate is carried as the x402 `mandate`-scheme payload — reuse `src/x402.ts` (`buildPaymentRequirements` / `createMandatePayment` / `MandateFacilitator`). AP2 is the intent layer; x402 is the wire; Sui is settlement.

Reuse, don't reinvent: `consent.ts`, `agent-auth.ts`, `x402.ts`, `biller.ts`, `client.ts` (`authorizeMetered`/`authorizeFixed`/`chargeMetered`). No new on-chain code.

### Script `scripts/ap2-smoke.ts` + `npm run ap2:smoke`
Deterministic (mock chain, real Ed25519 + agent-auth signatures), like `x402-smoke.ts`:
1. Build an AP2 **Intent Mandate** (price cap, window, merchant allowlist, prompt-playback) → `verifyAp2Mandate` → `intentToAuthorize` → `authorize` on iSub (one real mandate).
2. Build a **Cart Mandate** (exact total) → settle via x402 → assert on-chain `Charged` within caps.
3. Negatives: cart total > cap → rejected; expired intent → rejected; wrong merchant → `ETermsMismatch`; replayed cart → `EBadChargeSeq`.

### Surface
- Add `"./ap2": "./src/ap2.ts"` to `sdk/package.json` exports (mirrors `./x402`).
- Docs: a new `docs/guides/ap2.md` (or extend `ai-agents-mcp.md`) with the mapping table + a runnable example.
- Homepage / docs badge: move **`AP2-aligned` → `AP2-compatible`** once `ap2:smoke` is green (and only then).

## 4. Phasing
- **Phase 1 (MVP — earns "AP2-compatible"):** types + verify + intent/cart mappers + `ap2:smoke` (mock). ~1 focused session; no Move changes.
- **Phase 2:** end-to-end x402 bridge (AP2 Payment Mandate over the `mandate` scheme → real on-chain `charge_metered`), plus an A2A-shaped agent-to-agent handoff sample.
- **Phase 3:** exact VC/JWT conformance per the pinned AP2 spec version, DID/key model, interop test against official AP2 reference samples, testnet e2e, stablecoin `<T>` (USDC) carts.

## 5. Open questions / risks
- **Spec maturity & serialization.** AP2 is young; VC-vs-JWT and exact field names may shift. Pin a spec version, implement by shape, and note drift (same posture as `x402` V2-wire-compatible).
- **Key/identity model.** AP2 leans on DIDs / verifiable credentials; iSub uses Sui addresses + Ed25519. Need an address↔DID mapping (Phase 3).
- **Role honesty.** Be explicit that iSub is the Credential Provider / Merchant Payment Processor / settlement layer — not the shopping or merchant agent.
- **Claim discipline.** Stay "compatible / interoperable by shape" until tested against official AP2 samples; never imply Google certification.

## 6. Acceptance criteria
- `npm run ap2:smoke` green: AP2 Intent → `authorize` → Cart → settle on-chain, plus the 4 negative gates.
- An AP2 Intent Mandate round-trips to a real capped on-chain charge; a cart over cap is rejected on-chain.
- `@isubpay/sdk/ap2` exported + documented; the homepage/docs badge can move to **AP2-compatible** honestly.
- **Zero contract changes** — pure SDK adapter over existing `authorize` / `charge_metered` / x402.

## 7. Interface sketch
```typescript
import { verifyAp2Mandate, intentToAuthorize, cartToCharge, executeAp2 } from '@isubpay/sdk/ap2';

// 1. delegated intent (agent-not-present): user-signed, with caps + allowlist + prompt playback
const v = await verifyAp2Mandate(intentMandate);              // PoP / VC check
const params = intentToAuthorize(intentMandate, reviewedPlan); // → authorizeMetered params (terms-bound)
const { mandateId } = await isub.authorizeMetered(signer, params);

// 2. cart approval (human-present): exact total, settled over x402 → on-chain charge
const res = await executeAp2({ cart: cartMandate, mandateId, facilitator }); // verify → charge_metered
// res.digest, res.charged — within caps, or rejected (over-cap / expired / wrong-merchant)
```

## 8. Why this is worth doing
AP2 is the emerging standard for agentic commerce, backed by Google + Coinbase + 60 orgs, and its crypto rail is x402 — which iSub already ships. A thin, honest adapter makes iSub a **drop-in AP2 settlement layer on Sui** whose mandates are *enforced*, not merely *signed* — a real differentiator, achievable in one session with no contract risk.

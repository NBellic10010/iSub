# iSub — Sui-native subscription primitive

> **In one line:** non-custodial recurring pull payments (**no pre-funding**, sign once, capped, revocable anytime) — letting any Sui merchant/app add "subscriptions" in a single line of integration.
> Status: Phase 0–1.9 complete (contracts **68/68** + 4 rounds of security self-review + SDK/keeper/e2e over **gRPC**, green on **both localnet and Sui testnet**, 2026-06-13). Target: Sui Overflow 2026 (deadline 6/21, usually extended to ~6/23).

## What it is

Crypto payments have a proven, real pain point: **non-custodial wallets can't auto-charge** — stablecoins live in the user's own wallet, so a merchant can't pull a recurring fee without the user signing every time. Stripe can auto-renew; non-custodial crypto gateways can't.

**iSub solves this with Sui's object model (Account + Mandate):** the user keeps a balance in their own **payment Account they can withdraw from at any time**, then **signs once** to issue the merchant a **capped, revocable charge authorization (Mandate)** — **no pre-funding** (authorize moves no funds); the merchant (or a keeper) pulls from the user's Account each period, within the authorized limit. It's the **Sui equivalent of a Stripe card-on-file**. Positioned as a **primitive + SDK** — other merchants/apps embed it to collect subscriptions, rather than being yet another finished app.

## Why "subscriptions", not "streaming"

Streaming payments (Sablier / Streamflow / Coindrip) are already crowded globally and relatively simple (lock + linear release); **non-custodial delegated-pull subscriptions are a gap on Sui — harder, and they hit a real pain point**. See the validation conclusions in `product-plan/concept.md`.

## Billing & anti-replay (money-correctness)

The demo is the easy part; the hard part is being correct under failure. iSub gives three guarantees that separate a payment rail from a happy-path app:

- **Anti-replay (per call)** — every call carries a one-time `usageId` and an agent-signed proof bound to the *exact* charge. A verbatim replay is rejected (`409`); a forged/bearer call is rejected (`403`).
- **Exactly-once settlement (across crashes)** — charges accrue off-chain and settle in batches; before every on-chain charge the biller reconciles any *landed-but-unacked* charge (`recoverOrphan`), so a crash or lost ack never double-charges. `charge_seq` makes it idempotent on-chain.
- **Keeper-proof caps (on-chain)** — rate / per-charge / total-budget / balance / expiry are enforced by the contract. The keeper can only trigger charges the chain already permits, paid to the merchant — trust is liveness-only, never custody.

```mermaid
flowchart TD
    A["use(mandateId, amount, usageId, proof)"] --> B{"First-sight valid?<br/>merchant==payout · PAYG · Active · not expired"}
    B -- no --> S1["402 / 403 — not serviceable"]
    B -- yes --> C{"Agent proof-of-possession valid?<br/>bind-cert recovers to on-chain subscriber<br/>call-proof recovers to bound agent,<br/>bound to exact amount + usageId + not_after"}
    C -- "missing / forged / replayed on new usageId" --> S2["403 — bearer/replay rejected"]
    C -- "cert ver below durable floor (rotation)" --> S2
    C -- yes --> D{"remaining budget &ge; amount?"}
    D -- no --> S3["402 — out of budget"]
    D -- yes --> E{"usageId already recorded?<br/>(durable dedup)"}
    E -- "yes — verbatim replay" --> S4["409 — single-use, refuse re-serve"]
    E -- no --> F["record usage · accrue off-chain · serve"]
    F --> G{"pending &ge; threshold, or window tick?"}
    G -- no --> W["wait for next window"]
    G -- yes --> H["flush(mandate)"]

    H --> I["acquire single-biller lock<br/>(heartbeat lease + liveness probe → no split-brain)"]
    I --> J{"recoverOrphan:<br/>a submit at seq S has no matching 'charged'<br/>AND on-chain charge_seq &gt; S?"}
    J -- "yes — it landed (ack lost / crash)" --> K["markBilled(exact usageIds)<br/>back-fill 'charged' · DO NOT re-charge"]
    J -- no --> L["batch unbilled &le; spendable<br/>append 'submit' {seq, usageIds}"]
    K --> L
    L --> M["charge_metered(seq) — on-chain"]
    M --> N{"on-chain checks"}
    N -- "seq &ne; charge_seq (EBadChargeSeq)" --> J
    N -- "over rate / per-charge / budget / balance" --> O["rollback → shrink batch → retry"]
    O --> J
    N -- success --> P["commit: markBilled · 'charged' · seq++<br/>coins → merchant"]
    P --> Q(["Charged exactly once ✓<br/>on-chain digest + spent_total"])
```

Code: per-call gate in [`sdk/src/service.ts`](sdk/src/service.ts); settlement + `recoverOrphan` in [`sdk/src/biller.ts`](sdk/src/biller.ts); on-chain caps + `charge_seq` in [`contracts/sources/subscription.move`](contracts/sources/subscription.move); agent proof-of-possession in [`sdk/src/agent-auth.ts`](sdk/src/agent-auth.ts). Failure paths (lost-ack / crash / lock contention / replay) are covered by `npm run biller:smoke` and `npm run agent-auth:redteam`.

## Docs index

- [`product-plan/concept.md`](product-plan/concept.md) — concept, pain point, Sui-native differentiation, validation conclusions, principles fit, tracks/sponsors
- [`product-plan/architecture.md`](product-plan/architecture.md) — Move contract object model, charge/revoke, keeper, sponsored tx, SDK layering
- [`product-plan/scope-and-timeline.md`](product-plan/scope-and-timeline.md) — tiered scope (Tier 0–3), calendar plan, risks, realistic targets
- [`product-plan/privacy.md`](product-plan/privacy.md) — privacy model: unlinkable vs anonymous, burner/zkLogin/stealth addresses, deliberately no mixing
- [`sdk/README.md`](sdk/README.md) — TS SDK (gRPC) + e2e/keeper/payg/dunning scripts (localnet + testnet all green)
- [`product-plan/phase2-demo-app.md`](product-plan/phase2-demo-app.md) — merchant demo app plan (Phase 2)

## Origin

This direction was filtered out of the DeepBook topic exploration in `../PredictComposer` — after vetting ~ten DeepBook directions, all failed on "taken / too hard / won't win", and the only one verified as "a gap + feasible" was this subscription line. The full topic-selection principles and rejection record are in `../PredictComposer/topic-selection-principles.md`.

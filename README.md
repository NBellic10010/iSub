# iSub — Sui-native subscription primitive

> **In one line:** non-custodial recurring pull payments (**no pre-funding**, sign once, capped, revocable anytime) — letting any Sui merchant/app add "subscriptions" in a single line of integration.
> Status: Phase 0–1.9 complete (contracts **68/68** + 4 rounds of security self-review + SDK/keeper/e2e over **gRPC**, green on **both localnet and Sui testnet**, 2026-06-13). Target: Sui Overflow 2026 (deadline 6/21, usually extended to ~6/23).

## What it is

Crypto payments have a proven, real pain point: **non-custodial wallets can't auto-charge** — stablecoins live in the user's own wallet, so a merchant can't pull a recurring fee without the user signing every time. Stripe can auto-renew; non-custodial crypto gateways can't.

**iSub solves this with Sui's object model (Account + Mandate):** the user keeps a balance in their own **payment Account they can withdraw from at any time**, then **signs once** to issue the merchant a **capped, revocable charge authorization (Mandate)** — **no pre-funding** (authorize moves no funds); the merchant (or a keeper) pulls from the user's Account each period, within the authorized limit. It's the **Sui equivalent of a Stripe card-on-file**. Positioned as a **primitive + SDK** — other merchants/apps embed it to collect subscriptions, rather than being yet another finished app.

## Why "subscriptions", not "streaming"

Streaming payments (Sablier / Streamflow / Coindrip) are already crowded globally and relatively simple (lock + linear release); **non-custodial delegated-pull subscriptions are a gap on Sui — harder, and they hit a real pain point**. See the validation conclusions in `product-plan/concept.md`.

## Docs index

- [`product-plan/concept.md`](product-plan/concept.md) — concept, pain point, Sui-native differentiation, validation conclusions, principles fit, tracks/sponsors
- [`product-plan/architecture.md`](product-plan/architecture.md) — Move contract object model, charge/revoke, keeper, sponsored tx, SDK layering
- [`product-plan/scope-and-timeline.md`](product-plan/scope-and-timeline.md) — tiered scope (Tier 0–3), calendar plan, risks, realistic targets
- [`product-plan/privacy.md`](product-plan/privacy.md) — privacy model: unlinkable vs anonymous, burner/zkLogin/stealth addresses, deliberately no mixing
- [`sdk/README.md`](sdk/README.md) — TS SDK (gRPC) + e2e/keeper/payg/dunning scripts (localnet + testnet all green)
- [`product-plan/phase2-demo-app.md`](product-plan/phase2-demo-app.md) — merchant demo app plan (Phase 2)

## Origin

This direction was filtered out of the DeepBook topic exploration in `../PredictComposer` — after vetting ~ten DeepBook directions, all failed on "taken / too hard / won't win", and the only one verified as "a gap + feasible" was this subscription line. The full topic-selection principles and rejection record are in `../PredictComposer/topic-selection-principles.md`.

---
description: Non-custodial recurring & metered pull-payments on Sui — the payment rail for subscriptions and the AI-agent economy.
---

# What is iSub?

**iSub is a non-custodial pull-payment primitive on Sui.** A user signs **once** to authorize a **capped, revocable** mandate; the merchant (or a keeper) then pulls recurring or metered charges **within that cap** — and the funds never leave the user's control until the moment of each charge.

It is the Sui-native equivalent of "a card on file" — without the custody. Stripe can auto-renew because it holds a token for your card. Non-custodial crypto wallets normally can't: the stablecoin sits in the user's wallet and the merchant has no way to pull a recurring fee without a fresh signature every time. iSub closes that gap with Sui's object model.

```typescript
import { IsubClient, keypairSigner } from '@isub/sdk';

const isub = new IsubClient({ client, packageId });

// merchant: publish a plan
const { planId } = await isub.createPlanPayg(merchant, {
  rateCap: 100_000_000n,        // ≤ 0.1 SUI per window
  rateWindowMs: 60_000n,        // 60s rolling window
  keeper: keeper.address,
});

// subscriber: fund once, authorize once (moves no funds)
const { accountId } = await isub.openAccount(subscriber);
await isub.deposit(subscriber, { accountId, amount: 300_000_000n });
const { mandateId } = await isub.authorizeMetered(subscriber, {
  accountId, planId,
  expectedRateCap: 100_000_000n, expectedRateWindowMs: 60_000n,
  expectedMerchant: merchant.address, expectedKeeper: keeper.address,
  totalBudget: 200_000_000n, maxPerCharge: 50_000_000n,
  expiryMs: BigInt(Date.now() + 30 * 86_400_000),
});

// keeper: pull metered usage, within the cap
await isub.chargeMetered(keeper, { accountId, mandateId, amount: 10_000_000n, seq: 0n });
```

## Why iSub

* **No pre-funding.** Authorizing a mandate moves **zero** funds. The user keeps their balance in an `Account` they can withdraw from at any time.
* **Hard caps, enforced on-chain.** Every mandate carries a per-charge cap, a rolling rate cap (PAYG), a lifetime budget, and an expiry. The Move contract rejects any charge that breaks them — there is no trust in the merchant's backend.
* **Cancel anytime.** The subscriber can `revoke` (terminal), `pause`, or `withdraw` without anyone's permission.
* **One primitive, three shapes.** A single `Mandate` type backs **Fixed** subscriptions, **Pay-as-you-go** metering, and **AI-agent** budget-bounded session spending.
* **Verifiable.** Plans, mandates, and every charge are on-chain objects and events — auditable by anyone.

## Who it's for

| You are… | Use… |
| --- | --- |
| A merchant selling subscriptions or metered APIs | [`createPlanFixed` / `createPlanPayg`](reference/isub-client.md), the [checkout widget](guides/checkout-widget.md), and the [biller](guides/billing-automation.md) |
| A subscriber / wallet | [`openAccount` → `deposit` → `authorize*`](guides/subscriptions-fixed.md) |
| Building an AI agent that pays per call | [`IsubAgent`, x402 (`mandate` scheme) + the MCP server](guides/ai-agents-mcp.md) — x402-native, AP2-aligned |
| An operator who wants "integrate-and-go" without self-hosting a keeper | The [managed gateway](guides/managed-gateway.md) + the thin [`@isub/sdk/client`](reference/gateway-api.md) |

## How the pieces fit

```
Subscriber ──deposit──▶  Account<T>   (your withdraw-anytime balance)
Subscriber ──authorize─▶  Mandate<T>  (capped, revocable; holds NO funds)
Merchant   ──publish───▶  Plan<T>     (Fixed or PAYG terms)
Keeper/Merchant ─charge▶  Mandate ──pull──▶ Account ──pay──▶ Merchant wallet
```

Start with the [Quickstart](getting-started/quickstart.md), or read [Account · Plan · Mandate](concepts/core-concepts.md) to understand the model first.

> **Networks.** iSub runs on Sui **localnet** and **testnet** today. The testnet package id is `0xb11a3defcf0edb190edcf17aab87946a78ff514b1c547ff02dc5444b093bce7a`.

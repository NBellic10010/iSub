# Quickstart

This walks the full lifecycle — **publish a plan → fund & authorize → charge → cancel** — with three actors (merchant, subscriber, keeper). It mirrors the SDK's own e2e smoke (`sdk/scripts/smoke.ts`).

All amounts are in the coin's base units. For SUI that's **MIST** (1 SUI = `1_000_000_000n`).

## 0. Setup

```typescript
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { IsubClient, keypairSigner, MandateStatus } from '@isub/sdk';

const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });
const isub = new IsubClient({ client, packageId: '0xb11a…' });

const merchant   = keypairSigner(merchantKeypair, client);   // receives funds, publishes the plan
const subscriber = keypairSigner(subscriberKeypair, client); // funds an account, authorizes
const keeper     = keypairSigner(keeperKeypair, client);     // triggers charges
```

A **signer** is iSub's login abstraction. In Node you wrap a keypair with `keypairSigner`; in a browser you wrap a dApp-kit wallet with `walletSigner`. See [Signers](../reference/signers.md).

## 1. Merchant publishes a plan

```typescript
const PRICE = 50_000_000n;        // 0.05 SUI per period
const INTERVAL_MS = 2_000n;       // minimum 2s between charges

const { planId } = await isub.createPlanFixed(merchant, {
  price: PRICE,
  intervalMs: INTERVAL_MS,
  keeper: keeper.address,
});
```

A `Plan` is a shared on-chain object describing the terms. Use `createPlanPayg` instead for metered billing — see [Pay-as-you-go](../guides/pay-as-you-go.md).

## 2. Subscriber funds an account

```typescript
const { accountId } = await isub.openAccount(subscriber);
await isub.deposit(subscriber, { accountId, amount: 300_000_000n }); // 0.3 SUI
```

The `Account` is **the subscriber's own withdraw-anytime balance**. Depositing is optional up front — but charges can only settle against deposited funds.

## 3. Subscriber authorizes (signs once, moves no funds)

```typescript
const { mandateId } = await isub.authorizeFixed(subscriber, {
  accountId,
  planId,
  expectedPrice: PRICE,                 // the terms the USER reviewed
  expectedIntervalMs: INTERVAL_MS,
  expectedMerchant: merchant.address,
  totalBudget: 200_000_000n,            // 0.2 SUI lifetime cap on this mandate
  expiryMs: BigInt(Date.now() + 60 * 60 * 1000),
});

const m = await isub.getMandate(mandateId);
console.log(m.status === MandateStatus.Active, m.spentTotal); // true 0n
```

> ⚠️ The `expected*` fields are a **security feature**, not boilerplate. The chain aborts (`ETermsMismatch`) if they don't equal the Plan — defeating a tampered UI or a swapped plan. Pass **what the user was shown**, not values re-read from the plan you're authorizing. See [Trusted display](../concepts/trusted-display.md).

## 4. Keeper charges (within the cap)

```typescript
await isub.charge(keeper, { accountId, mandateId, amount: PRICE });
// account debited PRICE, merchant wallet credited PRICE, mandate.spentTotal == PRICE
```

`charge` is **permissionless for Fixed plans** — anyone can trigger a due charge; the contract enforces the exact `price`, the interval gate, the budget, and the balance. Charging again before `intervalMs` elapses aborts `EIntervalNotElapsed`.

For PAYG you call `chargeMetered(keeper, { accountId, mandateId, amount, seq })` — merchant/keeper-only, with an idempotency `seq`. See [Deduction rules](../concepts/deduction-rules.md).

## 5. Subscriber cancels (anytime)

```typescript
await isub.revoke(subscriber, { mandateId });   // terminal — no further charges
await isub.withdrawAll(subscriber, { accountId }); // pull remaining funds back to the wallet
```

## What just happened

* Authorizing moved **no** money — only a capped permission.
* Every charge was gated on-chain by the mandate's price/interval/budget/expiry.
* The subscriber could revoke or withdraw at any point without the merchant's cooperation.

From here:

* Automate charging with the [keeper & biller](../guides/billing-automation.md).
* Meter usage and price it with a [RateCard](../guides/pay-as-you-go.md).
* Drop a [checkout widget](../guides/checkout-widget.md) on your site so users authorize in an isolated iframe.

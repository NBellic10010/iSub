# @isub/sdk

TypeScript SDK + runnable scripts for **iSub** — a non-custodial recurring/metered
pull-payment primitive on Sui (Account + Mandate). The Sui equivalent of Stripe's
"card on file": **no pre-funding**, a capped + revocable authorization, and
cancel / withdraw anytime.

> Contract: [`../contracts`](../contracts) (`isub::subscription`). Model + threat
> model: [`../product-plan`](../product-plan).

## What's here

`src/` — the SDK, isomorphic and signer-agnostic (runs in Node and the browser), over a gRPC `SuiGrpcClient`:

| Module | Purpose |
|--------|---------|
| `IsubClient` | Build → execute → parse over gRPC. Writes (`openAccount`, `deposit`, `withdraw`, `createPlanFixed/Payg`, `deactivatePlan`, `authorizeFixed`, `authorizeMetered`, `charge`, `chargeMetered`, `refund`, `revoke`, `pause`, `resume`, `closeAccount`, `closeMandate`, `closePlan`) and reads (`getAccount`, `getPlan`, `getMandate`, `getMandates`, `quoteFromPlan`). |
| `tx` | Pure PTB builders — compose multiple calls into one transaction (transport-agnostic). |
| `accountExposure` | Total authorization vs balance across an account's mandates — show before each `authorize` (H-2). |
| `IsubSigner` / `keypairSigner` | The `login()` seam: one interface for a Node keypair, a browser wallet, or zkLogin. Normalizes execution into `IsubExecResult` (digest / success / structured abort code / events / created ids). |
| `IsubKeeper` | Off-chain keeper with a persistent billing state machine: lifecycle `active → past_due → recovered \| lapsed`, dunning policy, event callbacks (the merchant webhook seam), failure classification, drift detection against the on-chain charge counter. |
| `store` / `store-file` | Keeper persistence seam: durable watch set + append-only action journal + single-instance lock (`memoryStore` for tests, `fileStore` for servers). |
| `reconcile` | Journal vs chain reconciliation — exact per-mandate drift via the on-chain `charge_seq` counter (no event indexer needed). |
| `errors` | `IsubAbortError` (carries the real Move abort code) + `abortCodeOf`. |
| `constants` / `types` | Mirror of the Move module: modes, statuses, abort codes, parsed object state. |

`scripts/` — runnables (network via `ISUB_NETWORK`, default localnet): `publish.ts`,
`smoke.ts` (lifecycle e2e), `keeper-smoke.ts` (scheduling), `payg-smoke.ts` (metered
idempotency + refunds), `dunning-smoke.ts` (state machine + reconciliation),
`keeper.ts` (service), `reconcile.ts` (audit CLI), `fund.ts`, `grpc-probe.ts`.

## Run the e2e on localnet

Prereqs: `sui` CLI (tested on 1.71), Node ≥ 20.

```bash
# 1. start an ephemeral localnet with a faucet (leave running)
sui start --with-faucet --force-regenesis

# 2. install, publish, and exercise the whole primitive
cd sdk
npm install
npm run publish:localnet   # compile + publish, writes isub.localnet.json
npm run smoke              # open→deposit→authorize→charge×2→revoke→withdraw→close (19 assertions)
npm run keeper:smoke       # keeper auto-charges on schedule, stops at budget (7 assertions)
npm run payg:smoke         # metered charges: seq idempotency, rate cap, refunds (16 assertions)
npm run dunning:smoke      # past_due→recovered→lapsed, restart recovery, reconcile (12 assertions)
npm run keeper             # optional: run the keeper as a long-lived service
npm run reconcile          # audit a keeper journal against the chain
```

`smoke` also asserts the adversarial paths — pre-interval charge aborts
(`EIntervalNotElapsed`), post-revoke charge aborts (`ENotActive`) — and the core
invariants (authorize moves no funds; exact debit; merchant receipt; non-custodial exit).

## Run the e2e on testnet

The same scripts run on testnet over gRPC via `ISUB_NETWORK=testnet`. Actor keypairs
persist under `.secrets/testnet/` (gitignored). The testnet faucet is gated, so fund
the actors from your own wallet (one transfer; `fund.ts` disperses):

```bash
cd sdk && npm install
npm run fund:testnet          # creates .secrets/testnet/*.key; prints the funder address + amount
# → send that amount to the `publisher` (funder); re-run to disperse to subscriber/merchant/keeper
npm run publish:testnet       # writes isub.testnet.json (persistent package id)
npm run smoke:testnet         # 19 assertions on testnet
npm run keeper-smoke:testnet  # 7 assertions on testnet
```

Verified deployment: package
[`0x573710f6…2616`](https://suiscan.xyz/testnet/object/0x573710f6a496fe01be0bcc8dd1d13f564465e75e2a6566856715772d326a2616)
— all four suites green on testnet (19 + 7 + 16 + 12 assertions).

## Authorizing safely (terms binding)

`authorizeFixed` / `authorizeMetered` take the **expected terms** the user reviewed and
the chain rejects a mismatch (`ETermsMismatch`) — defeating a UI that lies about price or
a swapped plan. This only protects the user if those `expected*` values come from a
surface the merchant doesn't control (a wallet rendering the on-chain `Plan`, a neutral
checkout). **Do not** source them by re-reading the same plan — `quoteFromPlan` is for
display only. PAYG adds a user-set `maxPerCharge` (a per-charge throttle, not a lifetime
cap) and an optional `firstChargeAfterMs` review window.

## Merchant integration notes

- A `Mandate` is a **revocable authorization intent, not a guaranteed receivable.** A
  `charge` can legitimately fail (`EInsufficientAccount`) if the subscriber withdrew —
  this is the intended non-custodial exit right. Gate service on the keeper's
  `mandate.past_due` event; bad-debt is bounded to ≈ one billing period (no net-30
  accrual). Recovery is signature-free: the user tops up, the next tick charges.
- One Account backs many mandates (first-come-first-served). Call `accountExposure()` and
  show total authorization vs balance **before** the user signs another `authorize`.
- Refunds go **back into the Account** via `refund` (merchant-only); they do not restore
  budget. See the security self-assessment (`../product-plan/self-audit.md`).

## Coin type

The primitive is generic over `<T>`. The scripts default to SUI on localnet;
switching to USDC / USDsui is a one-line change:

```ts
new IsubClient({ client, packageId, coinType: '0x…::usdc::USDC' });
```

## Status

**Phase 1 ✅** — SDK (gRPC) + keeper + e2e green on **localnet and testnet** (Sui 1.71, `@mysten/sui` v2).
The browser / dApp surface is Phase 2 — see
[`../product-plan/phase2-demo-app.md`](../product-plan/phase2-demo-app.md).

# Checkout widget

A drop-in **subscribe button** that opens iSub's hosted checkout in an isolated iframe. The user reviews the **real on-chain terms** and authorizes with their wallet — on iSub's origin, so the merchant page can't fake the surface.

## Embed

```html
<script src="https://checkout.isub.app/loader.js"></script>
<button id="subscribe">Subscribe</button>
<script>
  iSubCheckout.open({
    planId: '0x…',          // your published plan
    budget: '0.2',          // SUI decimal — the user's lifetime cap on this mandate
    ttlDays: 30,            // mandate expiry
    maxPerCharge: '0.05',   // optional (PAYG) — defaults to the plan's rate cap
    consent: true,          // optional — also capture a signed plain-language consent
    onResult: ({ ok, mandateId, accountId }) => { /* provision access */ },
  });
</script>
```

The merchant supplies only `planId` + caps. **The terms shown are read from chain inside the iframe** (`quoteFromPlan`), not from anything the merchant passes — see [Trusted display](../concepts/trusted-display.md).

## What happens inside

1. The iframe reads the plan's real terms from chain and renders them (price/rate, merchant, budget).
2. The user connects a wallet (`ConnectButton` from dApp-kit) — wallet **or** zkLogin.
3. If `consent` is set, the widget asks the wallet to `signPersonalMessage` a human-readable intent.
4. It opens an account if needed, then calls `authorizeFixed` / `authorizeMetered` with `expected*` = the shown terms (chain verifies they equal the Plan, else `ETermsMismatch`).
5. It posts the result back to your page.

## Result message

The iframe `postMessage`s to the loader's origin:

```typescript
// success
{ source: 'isub-checkout', type: 'isub:result', ok: true, mandateId, accountId }
// cancelled
{ source: 'isub-checkout', type: 'isub:cancel', ok: false }
```

On success, persist `mandateId` (and `accountId`) against the user and start serving. If you run the [managed gateway](managed-gateway.md), the widget also ingests the mandate into the relationship index so it's discoverable cross-device.

## Standalone route

The same component is a full page in the iSub web app at `/checkout?planId=…&budget=…&ttlDays=…&maxPerCharge=…&consent=1&origin=…`. The embeddable loader simply iframes this route, so you can also link to it directly or self-host the `web/` app.

## After checkout

The user manages everything from their iSub dashboard (`/app`): balances, pause/resume/revoke, per-mandate usage charts, and a wallet-wide usage rollup. Charging is then driven by your [keeper/biller](billing-automation.md).

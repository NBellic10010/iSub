# iSub — wallet-connect demo dApp

A minimal browser dApp that shows the whole **non-custodial subscription** loop on Sui,
driven entirely by a connected wallet:

1. **Connect wallet = sign in.** No password, no server-side account — your wallet address
   *is* your identity.
2. **Open an Account** — a reusable balance you control (withdraw anytime).
3. **Subscribe** to a plan — authorize a capped, revocable mandate. Signs once, **moves no funds**.
4. **Charge a period** — see a real pull debit your Account (in production the merchant/keeper
   does this on schedule).
5. **Unsubscribe** — revoke on-chain; no future charges.

It reuses the **same `@isubpay/sdk` seam** the keeper, CLI, and smoke tests use. The only
browser-specific piece is the wallet bridge in [`src/isub.ts`](src/isub.ts) — about 15 lines
that turn dApp-kit's connected wallet into an `IsubSigner`. `<ConnectButton/>` is the login UI.

## Run

```bash
cd demo
npm install
npm run dev        # serves https://localhost:5173
```

> **HTTPS is required.** Sui wallets (Slush etc.) only connect over a *secure context* — they
> reject `http://localhost` with "connection not secure". The dev server therefore runs over
> https with a self-signed cert (`@vitejs/plugin-basic-ssl`). The first time you open
> `https://localhost:5173`, the browser shows a cert warning — click **Advanced → proceed to
> localhost**. After that the origin is secure and the wallet connects normally.

You need a **Sui testnet wallet** (e.g. the Sui Wallet / Slush browser extension) with a little
testnet SUI for gas — get some from the testnet faucet, or send from your CLI wallet:

```bash
sui client faucet            # if your active env is testnet
# or transfer from a funded testnet address
```

Then: connect → **Open account** → **Deposit** ~0.1 SUI → **Create demo plan** (you act as the
merchant) → **Subscribe** → **Charge 1 period** (watch the balance drop) → **Unsubscribe**.

`npm run typecheck` type-checks the app (and the SDK source it imports) without emitting;
`npm run build` produces a static bundle in `dist/`.

## How it's wired

- [`src/dapp-kit.ts`](src/dapp-kit.ts) — the single `createDAppKit` instance (testnet) + the
  published package id. dApp-kit manages wallet connection and the active network.
- [`src/isub.ts`](src/isub.ts) — `useIsub()` bridges the connected wallet into the SDK. It builds
  its **own** `SuiGrpcClient` (the SDK calls top-level gRPC methods, identical to the Node path the
  contracts were tested against) and uses the wallet **only to sign** — execution + id/abort parsing
  stay byte-for-byte the same as the keeper. The SDK is consumed straight from TypeScript source via
  a Vite alias (`../sdk/src`), with `@mysten/sui` deduped to a single copy.
- [`src/App.tsx`](src/App.tsx) — the UI for the five steps above. The app records the user's
  Account/mandate ids in `localStorage` (gRPC has no "objects by owner" query for these types — the
  SDK documents id-recording as the integrator's job; a real merchant backend would persist them).

## Notes & limits

- **Testnet only** by default. Point at another network by editing `GRPC_URLS` / `PACKAGE_IDS` /
  `networks` in `src/dapp-kit.ts`. Browser wallets generally don't expose localnet, so use the Node
  smokes (`../sdk`) for localnet.
- **Terms-binding (demo simplification):** the subscribe step echoes `expected*` from the quote it
  just rendered. In production these must come from a *trusted* display surface, not a re-read of the
  plan you're authorizing — see the SDK's `authorizeFixed` docs. The on-chain check still aborts a
  swapped/changed plan (`ETermsMismatch`).
- No indexer/backend: state is read on demand and refreshed after each action (writes resolve only
  after the fullnode has indexed them, so reads are never stale). A production app would add an
  indexer + TanStack Query.

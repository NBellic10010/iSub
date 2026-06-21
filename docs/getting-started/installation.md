# Installation

## Requirements

* **Node.js ≥ 22.5** (the SDK uses native `fetch` and, for the gateway/biller stores, the built-in `node:sqlite` — run those scripts with `--experimental-sqlite`).
* **TypeScript ≥ 5** (the SDK ships as `.ts` and is consumed via `transpilePackages` / `tsx`).
* A Sui RPC endpoint. The SDK talks **gRPC** via `@mysten/sui`.

## Install

```bash
npm install @isub/sdk @mysten/sui
```

`@mysten/sui` is a peer dependency — the SDK builds transactions with it and you construct the gRPC client with it.

> In the iSub monorepo the SDK is the workspace package `@isub/sdk` (root `package.json` `workspaces: ["sdk", "web", "checkout"]`), which hoists a single copy of `@mysten/sui`. A web app consumes it with `transpilePackages: ['@isub/sdk']` in `next.config.ts`.

## Construct a client

```typescript
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { IsubClient } from '@isub/sdk';

const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

const isub = new IsubClient({
  client,
  packageId: '0xb11a3defcf0edb190edcf17aab87946a78ff514b1c547ff02dc5444b093bce7a', // testnet
  // coinType defaults to '0x2::sui::SUI'; pass another fully-qualified type for USDC etc.
});
```

`IsubClient` wraps the gRPC client plus an `IsubConfig` (`packageId` + `coinType` for the generic `<T>`). The underlying gRPC client is exposed as `isub.client` if you need raw reads (e.g. `isub.client.getBalance({ owner })`).

## Subpath exports

The package is split so you only pull in what you use:

| Import | Contents |
| --- | --- |
| `@isub/sdk` | `IsubClient`, signers, types, constants, errors, pricing, `IsubKeeper`, `accountExposure`, `scheduleLag`, … |
| `@isub/sdk/agent` | `IsubAgent`, `agentTools` (budget-bounded agent spending) |
| `@isub/sdk/biller` | `IsubBiller` (PAYG usage → metered charges) |
| `@isub/sdk/gateway` | `IsubGateway` (managed multi-tenant HTTP gateway) |
| `@isub/sdk/relations` | `IsubIndex` (off-chain relationship index) |
| `@isub/sdk/client` | `IsubServiceClient`, `verifyWebhook` (thin client → gateway) |
| `@isub/sdk/mcp` | `createIsubMcpServer` (Model Context Protocol server) |
| `@isub/sdk/x402` | x402 (seller · buyer · facilitator), the `mandate` scheme — agent payments |
| `@isub/sdk/sql-store` · `/db` · `/store-file` | persistence backends |
| `@isub/sdk/webhook` · `/service` | webhook signing/verifying, single-tenant service |

## Networks & package ids

| Network | Base URL | Package id |
| --- | --- | --- |
| testnet | `https://fullnode.testnet.sui.io:443` | `0xb11a3defcf0edb190edcf17aab87946a78ff514b1c547ff02dc5444b093bce7a` |
| localnet | `http://127.0.0.1:9000` | from `sdk/isub.localnet.json` after `npm run publish:localnet` |

For local development: `sui start --force-regenesis --with-faucet`, then `cd sdk && npm run publish:localnet`. See [Billing automation](../guides/billing-automation.md) for the end-to-end localnet scripts.

Next: the [Quickstart](quickstart.md).

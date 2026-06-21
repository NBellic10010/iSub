# Signers

`IsubSigner` is iSub's **login abstraction**. Every state-changing call goes through it, so the same client code runs whether you sign with a Node keypair, a browser wallet, or zkLogin.

```typescript
interface IsubSigner {
  readonly address: string;   // the address that signs and pays gas
  signAndExecute(input: { transaction: Transaction }): Promise<IsubExecResult>;
}
```

```typescript
interface IsubExecResult {
  digest: string;
  success: boolean;
  abortCode: number | null;   // Move abort code if it failed with a MoveAbort
  events: { type: string; json: Record<string, unknown> | null }[];
  createdIds: string[];       // object ids created by this tx
}
```

The signer normalizes raw transport results into `IsubExecResult`, so the client/keeper never import gRPC generics.

## Node / CLI — `keypairSigner`

```typescript
import { keypairSigner } from '@isub/sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const signer = keypairSigner(keypair, client); // keypair: any @mysten/sui Signer (Ed25519/Secp256k1/Secp256r1)
```

It signs, executes, **waits for the fullnode to index the tx** (read-after-write barrier), and normalizes the result. If resolution/dry-run rejects an aborting tx before submit, it still recovers the abort code into `IsubExecResult`.

## Browser — `walletSigner`

```typescript
import { walletSigner } from '@isub/sdk';

const signer = walletSigner(adapter, client); // adapter: a dApp-kit wallet adapter
```

Wrap a `@mysten/dapp-kit` wallet. The bridge typically looks like:

```typescript
// from the dApp-kit connected account + the dApp-kit instance
const signer = {
  address: account.address,
  async signAndExecute({ transaction }) {
    transaction.setSenderIfNotSet(account.address);
    const { bytes, signature } = await dAppKit.signTransaction({ transaction });
    // execute the signed bytes via the gRPC client, then normalize
  },
};
```

In the iSub web app this is the `useIsub()` hook (`web/lib/use-isub.ts`), which returns `{ isub, signer, signMessage, address, connected, network }`. `signMessage` wraps `signPersonalMessage` for capturing [signed consent](../concepts/trusted-display.md).

## zkLogin / Enoki

Any signer that produces the `IsubSigner` shape works — including a zkLogin/Enoki-backed one. The client code is unchanged; only the `signAndExecute` implementation differs.

## Who must sign what

| Action | Required signer |
| --- | --- |
| `openAccount` / `deposit` / `withdraw*` | the account **owner** (subscriber) |
| `authorize*` / `pause` / `resume` / `revoke` | the **subscriber** |
| `createPlan*` / `deactivatePlan` / `refund` | the **merchant** |
| `charge` (Fixed) | **anyone** (permissionless) |
| `chargeMetered` (PAYG) | the **merchant** or the plan's **keeper** |

Passing the wrong signer aborts with the matching code (`ENotOwner`, `ENotSubscriber`, `ENotMerchant`, `ENotAuthorizedCharger`, …).

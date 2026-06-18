import type { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { fromBase64 } from '@mysten/sui/utils';
import { EXEC_INCLUDE, execResultFromThrow, normalizeExecResult, type IsubSigner } from './signer';

/** A signed transaction as returned by dapp-kit's `useSignTransaction` (base64 strings). */
export interface SignedTransaction {
  bytes: string;
  signature: string;
}

/**
 * The browser-wallet shape iSub needs — structurally identical to dapp-kit's
 * `useSignTransaction().mutateAsync` plus the connected account address. Keeping it
 * structural means the SDK takes ZERO frontend dependency: any wallet / zkLogin /
 * Enoki adapter that can sign a `Transaction` conforms.
 */
export interface WalletAdapter {
  address: string;
  signTransaction(input: { transaction: Transaction }): Promise<SignedTransaction>;
}

/**
 * Browser signer: the wallet signs, the SDK's gRPC client executes — so result
 * parsing (created ids, abort codes, events) is byte-for-byte identical to the Node
 * path. Same `IsubSigner` seam as `keypairSigner`, so the entire SDK and the
 * `<IsubSubscribe>` component run unchanged in the browser. Wire it up with dapp-kit:
 *
 * ```ts
 * const account = useCurrentAccount();
 * const { mutateAsync: signTransaction } = useSignTransaction();
 * const signer = walletSigner({ address: account.address, signTransaction }, client);
 * await isub.authorizeFixed(signer, { ... });
 * ```
 */
export function walletSigner(adapter: WalletAdapter, client: SuiGrpcClient): IsubSigner {
  return {
    address: adapter.address,
    async signAndExecute({ transaction }) {
      let signed: SignedTransaction;
      try {
        signed = await adapter.signTransaction({ transaction });
      } catch (e) {
        return execResultFromThrow(e); // user rejected / wallet error → surface (abort code if any)
      }
      try {
        const res = await client.executeTransaction({
          transaction: fromBase64(signed.bytes),
          signatures: [signed.signature],
          include: EXEC_INCLUDE,
        });
        return normalizeExecResult(res, client);
      } catch (e) {
        return execResultFromThrow(e);
      }
    },
  };
}

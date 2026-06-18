import { useMemo } from 'react';
import { useCurrentAccount, useCurrentNetwork, useDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { IsubClient, walletSigner, type IsubSigner } from '@isub/sdk';
import { GRPC_URLS, PACKAGE_IDS } from './dapp-kit';

export interface IsubHandle {
  isub: IsubClient;
  /** Null until a wallet is connected. Pass it to any `isub.*` write. */
  signer: IsubSigner | null;
  address: string | null;
  connected: boolean;
  network: string;
}

/**
 * Bridge dApp-kit's connected wallet into the iSub SDK — this is the whole "login".
 *
 * Design note: we build our OWN `SuiGrpcClient` rather than using `useCurrentClient()`.
 * The SDK calls top-level gRPC methods (`executeTransaction` / `getObject` /
 * `waitForTransaction`), which is exactly what `new SuiGrpcClient({ network, baseUrl })`
 * exposes — byte-for-byte the same client the contracts were tested against on Node.
 * It's memoized on `network`, so wallet network-switching still swaps the client.
 *
 * The wallet is used ONLY to sign (`dAppKit.signTransaction`); our client executes the
 * signed bytes. So created-id parsing, abort decoding, and the read-after-write barrier
 * are identical to the keeper/smoke path — the browser path adds no new trust surface.
 */
export function useIsub(): IsubHandle {
  const account = useCurrentAccount();
  const network = useCurrentNetwork();
  const dAppKit = useDAppKit();

  const client = useMemo(
    () => new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] ?? GRPC_URLS.testnet! }),
    [network],
  );

  const isub = useMemo(
    () => new IsubClient({ client, packageId: PACKAGE_IDS[network] ?? PACKAGE_IDS.testnet! }),
    [client, network],
  );

  const signer = useMemo<IsubSigner | null>(() => {
    if (!account) return null;
    return walletSigner(
      {
        address: account.address,
        signTransaction: ({ transaction }) => {
          // Set the sender ourselves so it's correct regardless of wallet defaults.
          transaction.setSenderIfNotSet(account.address);
          return dAppKit.signTransaction({ transaction });
        },
      },
      client,
    );
  }, [account, client, dAppKit]);

  return { isub, signer, address: account?.address ?? null, connected: !!account, network };
}

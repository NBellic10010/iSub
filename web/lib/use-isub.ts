'use client';
import { useMemo } from 'react';
import { useCurrentAccount, useCurrentNetwork, useDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { IsubClient, walletSigner, type IsubSigner } from '@isubpay/sdk';
import { GRPC_URLS, PACKAGE_IDS } from './dapp-kit';

export interface IsubHandle {
  isub: IsubClient;
  /** Null until a wallet is connected. Pass it to any `isub.*` write. */
  signer: IsubSigner | null;
  /** Sign a plain-language consent intent (signPersonalMessage). Null until connected. */
  signMessage: ((message: string) => Promise<{ signature: string; address: string }>) | null;
  address: string | null;
  connected: boolean;
  network: string;
}

/**
 * Bridge dApp-kit's connected wallet into the iSub SDK — the whole "login". Ported verbatim
 * from the proven demo bridge: we build our OWN SuiGrpcClient (the SDK calls top-level gRPC
 * methods, identical to the Node path the contracts were tested against) and use the wallet
 * ONLY to sign; execution + id/abort parsing stay byte-for-byte the same as the keeper.
 * Memoized on `network`, so wallet network-switching swaps the client.
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
          transaction.setSenderIfNotSet(account.address);
          return dAppKit.signTransaction({ transaction });
        },
      },
      client,
    );
  }, [account, client, dAppKit]);

  const signMessage = useMemo(() => {
    if (!account) return null;
    return async (message: string): Promise<{ signature: string; address: string }> => {
      const { signature } = await dAppKit.signPersonalMessage({ message: new TextEncoder().encode(message) });
      return { signature, address: account.address };
    };
  }, [account, dAppKit]);

  return { isub, signer, signMessage, address: account?.address ?? null, connected: !!account, network };
}

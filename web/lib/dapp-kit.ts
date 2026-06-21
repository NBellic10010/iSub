import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';

export const GRPC_URLS: Record<string, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};

/** Published iSub package per network — update after each publish/upgrade. */
export const PACKAGE_IDS: Record<string, string> = {
  testnet: '0xb11a3defcf0edb190edcf17aab87946a78ff514b1c547ff02dc5444b093bce7a',
  localnet: '0xb9e0697463525139baa053359e344aaa39e3ebc3a5dc4a70bd99f137bac9c6ab',
};

// One dApp-kit instance for the whole app (wallet connection + active network).
// iSub talks to the chain through its OWN SuiGrpcClient (see use-isub.ts).
export const dAppKit = createDAppKit({
  // Start every visit signed-OUT — don't silently reconnect the last wallet (default is true).
  // The subscriber/merchant dashboards gate on `connected` and show a Connect prompt instead.
  autoConnect: false,
  networks: ['testnet', 'localnet'],
  defaultNetwork: 'testnet',
  createClient: (network) => new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network]! }),
});

declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}

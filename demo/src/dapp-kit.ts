import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';

/** gRPC-web base URLs (the fullnode serves gRPC on the same host as JSON-RPC). */
export const GRPC_URLS: Record<string, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
};

/** Published iSub package per network — update after each `publish`/`upgrade`. */
export const PACKAGE_IDS: Record<string, string> = {
  testnet: '0xb11a3defcf0edb190edcf17aab87946a78ff514b1c547ff02dc5444b093bce7a',
};

// One dApp-kit instance for the whole app. It manages wallet connection + the active
// network. (iSub itself talks to the chain through its own SuiGrpcClient — see isub.ts.)
export const dAppKit = createDAppKit({
  networks: ['testnet'],
  defaultNetwork: 'testnet',
  createClient: (network) => new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network]! }),
});

// Typed hooks pick up the instance type without passing it manually.
declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}

// Shared helpers for the network scripts (publish, smoke, keeper).
// Network is selected by ISUB_NETWORK (default localnet). Uses the gRPC client.
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { getFaucetHost, requestSuiFromFaucetV2, FaucetRateLimitError } from '@mysten/sui/faucet';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type Network = 'localnet' | 'devnet' | 'testnet' | 'mainnet';

/** Network for this run: `ISUB_NETWORK=testnet npm run …` (default localnet). */
export const NETWORK = (process.env.ISUB_NETWORK ?? 'localnet') as Network;

/** gRPC-web base URLs (same host as JSON-RPC; the fullnode serves both). */
const BASE_URL: Record<Network, string> = {
  localnet: 'http://127.0.0.1:9000',
  devnet: 'https://fullnode.devnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
};

const here = dirname(fileURLToPath(import.meta.url));
const SECRETS = join(here, '..', '.secrets');

/** gRPC-web base URL for a network. */
export function baseUrlFor(network: Network = NETWORK): string {
  return BASE_URL[network];
}

/** A `SuiGrpcClient` for the given network (defaults to the run's NETWORK). */
export function clientFor(network: Network = NETWORK): SuiGrpcClient {
  return new SuiGrpcClient({ network, baseUrl: BASE_URL[network] });
}
/** Back-compat alias used by older localnet scripts. */
export function localClient(): SuiGrpcClient {
  return clientFor('localnet');
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Deployment {
  packageId: string;
  network: Network;
  baseUrl: string;
}

/** Per-network deployment record, e.g. `isub.testnet.json`. */
export function deploymentPath(network: Network = NETWORK): string {
  return join(here, '..', `isub.${network}.json`);
}

export function saveDeployment(d: Deployment): void {
  writeFileSync(deploymentPath(d.network), JSON.stringify(d, null, 2) + '\n');
}

export function loadDeployment(network: Network = NETWORK): Deployment {
  const path = deploymentPath(network);
  if (!existsSync(path)) {
    throw new Error(`no deployment at ${path} — run \`ISUB_NETWORK=${network} npm run publish:${network}\` first`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Deployment;
}

export async function suiBalance(client: SuiGrpcClient, owner: string): Promise<bigint> {
  const { balance } = await client.getBalance({ owner });
  return BigInt(balance.balance);
}

export async function waitForGas(client: SuiGrpcClient, owner: string, minMist = 1n): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if ((await suiBalance(client, owner)) >= minMist) return;
    await sleep(250);
  }
  throw new Error(`faucet timeout: ${owner} never reached ${minMist} MIST`);
}

/** localnet: a fresh, faucet-funded ephemeral keypair (regenesis wipes everything anyway). */
export async function fundedKeypair(client: SuiGrpcClient, minMist = MIST_PER_SUI): Promise<Ed25519Keypair> {
  const kp = Ed25519Keypair.generate();
  await requestSuiFromFaucetV2({ host: getFaucetHost('localnet'), recipient: kp.toSuiAddress() });
  await waitForGas(client, kp.toSuiAddress(), minMist);
  return kp;
}

/**
 * A named actor keypair for the run's network.
 *  - localnet → ephemeral + faucet (state is wiped on every regenesis).
 *  - testnet/devnet → PERSISTENT under `.secrets/<network>/<name>.key` (gitignored),
 *    funded on demand (faucet, with a clear fund-from-your-wallet fallback on limit).
 * Reuse avoids hammering the rate-limited testnet faucet on every run.
 */
export async function actor(
  client: SuiGrpcClient,
  name: string,
  network: Network = NETWORK,
  minMist = MIST_PER_SUI / 10n, // 0.1 SUI floor — actors are funded generously up front; testnet faucet is gated
): Promise<Ed25519Keypair> {
  if (network === 'localnet') return fundedKeypair(client, minMist);
  const kp = loadOrCreateActor(name, network);
  await ensureFunded(client, kp.toSuiAddress(), network, minMist, name);
  return kp;
}

/** Load (or create + persist under `.secrets/`) a named keypair. No funding — see `actor`. */
export function loadOrCreateActor(name: string, network: Network = NETWORK): Ed25519Keypair {
  const dir = join(SECRETS, network);
  const file = join(dir, `${name}.key`);
  if (existsSync(file)) return Ed25519Keypair.fromSecretKey(readFileSync(file, 'utf8').trim());
  const kp = Ed25519Keypair.generate();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, kp.getSecretKey() + '\n', { mode: 0o600 });
  return kp;
}

async function ensureFunded(
  client: SuiGrpcClient,
  address: string,
  network: Network,
  minMist: bigint,
  name: string,
): Promise<void> {
  if ((await suiBalance(client, address)) >= minMist) return;
  try {
    await requestSuiFromFaucetV2({ host: faucetHostFor(network), recipient: address });
    await waitForGas(client, address, minMist);
    return;
  } catch (e) {
    if ((await suiBalance(client, address)) >= minMist) return;
    const why = e instanceof FaucetRateLimitError ? 'rate-limited' : 'unavailable';
    const have = fmt(await suiBalance(client, address));
    throw new Error(
      `actor "${name}" underfunded (${have} < ${fmt(minMist)}) and the ${network} faucet is ${why}.\n` +
        `Fund it from your wallet, then re-run:\n` +
        `  sui client transfer-sui --to ${address} --amount ${minMist} --gas-budget 5000000\n` +
        `or send ~${fmt(minMist)} to ${address} from any funded ${network} wallet.`,
    );
  }
}

/** Faucet host for a network (mainnet has none). */
export function faucetHostFor(network: Network): string {
  if (network === 'mainnet') throw new Error('no faucet on mainnet — fund the address manually');
  return getFaucetHost(network);
}

/** Pretty-print MIST as SUI for logs. */
export const fmt = (mist: bigint): string => `${(Number(mist) / Number(MIST_PER_SUI)).toFixed(4)} SUI`;

/** Suiscan explorer links for the run's network. */
export function explorer(network: Network = NETWORK): {
  object: (id: string) => string;
  tx: (digest: string) => string;
  account: (addr: string) => string;
} {
  const base = `https://suiscan.xyz/${network}`;
  return {
    object: (id) => `${base}/object/${id}`,
    tx: (digest) => `${base}/tx/${digest}`,
    account: (addr) => `${base}/account/${addr}`,
  };
}

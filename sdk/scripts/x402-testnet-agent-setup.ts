// Testnet-backed x402 agent: loads scripts/.x402-testnet.json (from x402-testnet-setup.ts), wires a
// REAL IsubClient + keeper signer + SQL biller, and builds the agent server via buildAgentServer.
// Each `pay` settles on-chain (charge_metered) and returns the real digest + suiscan link.
// Requires NODE_OPTIONS=--experimental-sqlite (the biller store uses node:sqlite).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubClient, keypairSigner } from '../src/index';
import { IsubService } from '../src/service';
import { openDb } from '../src/db';
import { sqlBillerStore } from '../src/sql-store';
import { MandateFacilitator, type X402Network } from '../src/x402';
import { IsubIndex } from '../src/relations';
import { buildAgentServer, type PaidApi, type AgentServer } from './x402-agent-core';
import { clientFor, loadOrCreateActor, explorer } from './env';
import type { AgentCert } from '../src/agent-auth';
import type { Network } from './env';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, '.x402-testnet.json');

interface Cfg {
  network: Network;
  packageId: string;
  mandateId: string;
  accountId: string;
  payoutAddress: string;
  agentSecretKey: string;
  cert: { agent: string; notAfter: string; ver: number; sig: string };
  asset: string;
  apis: { path: string; price: string; label: string }[];
}

export interface TestnetAgent extends AgentServer {
  mandateId: string;
  agentAddress: string;
  subscriberAddress: string;
  log: (...a: unknown[]) => void;
  explorerMandate: string;
}

export async function setupX402Testnet(): Promise<TestnetAgent> {
  let cfg: Cfg;
  try { cfg = JSON.parse(readFileSync(CONFIG, 'utf8')) as Cfg; }
  catch { throw new Error('no scripts/.x402-testnet.json — run `npm run x402-testnet:setup` first'); }

  const client = clientFor(cfg.network);
  const isub = new IsubClient({ client, packageId: cfg.packageId });
  const keeper = keypairSigner(loadOrCreateActor('keeper', cfg.network), client);
  const agentKp = Ed25519Keypair.fromSecretKey(cfg.agentSecretKey);
  const cert: AgentCert = { agent: cfg.cert.agent, notAfter: BigInt(cfg.cert.notAfter), ver: cfg.cert.ver, sig: cfg.cert.sig };
  const ex = explorer(cfg.network);

  // Write into the SAME index db the gateway/dashboard reads (default isub-index.<network>.db, or
  // ISUB_INDEX_DB) so each on-chain charge shows up on the web UsageChart — not an isolated db.
  const db = openDb(process.env.ISUB_INDEX_DB ?? join(here, '..', `isub-index.${cfg.network}.db`));
  const service = new IsubService(isub, keeper, cfg.payoutAddress, sqlBillerStore(db, 'x402demo'), { windowMs: 3_600_000, agentAuth: 'enforce' });
  const facilitator = new MandateFacilitator(service, `sui-${cfg.network}` as X402Network);
  const log = (...a: unknown[]): void => console.error('[isub-x402-testnet]', ...a);

  // Ingest the mandate/account into the index so the dashboard can resolve them too (chart reads the
  // biller's charge journal in this same db; ingest also enables /relations discovery).
  try {
    const index = new IsubIndex(isub, db);
    await index.ingestMandate(cfg.mandateId);
    await index.ingestAccount(cfg.accountId);
  } catch (e) { log('index ingest skipped:', e instanceof Error ? e.message : e); }

  const apis: PaidApi[] = cfg.apis.map((a) => ({
    path: a.path,
    price: BigInt(a.price),
    label: a.label,
    run: () => (a.path === '/weather' ? { location: 'Tokyo, JP', tempC: 26, forecast: 'humid & warm' } : { ticker: 'NVDA', price: 1234.5, source: 'demo-feed' }),
  }));

  const srv = buildAgentServer({
    facilitator,
    mandateId: cfg.mandateId,
    agentKp,
    cert,
    payoutAddress: cfg.payoutAddress,
    asset: cfg.asset,
    network: `sui-${cfg.network}` as X402Network,
    apis,
    log,
    // settle on-chain (real charge_metered) and surface the digest + suiscan link
    confirm: async (id) => {
      const fr = await service.flush(id);
      const digest = fr.find((r) => r.digest)?.digest;
      return { digest, explorer: digest ? ex.tx(digest) : undefined };
    },
    getMandate: async (id) => {
      const m = await isub.getMandate(id);
      return { spentTotal: m.spentTotal, totalBudget: m.totalBudget };
    },
  });

  return { ...srv, mandateId: cfg.mandateId, agentAddress: agentKp.toSuiAddress(), subscriberAddress: cfg.payoutAddress, log, explorerMandate: ex.object(cfg.mandateId) };
}

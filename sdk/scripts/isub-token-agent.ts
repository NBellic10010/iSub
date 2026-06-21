// Scenario 4 MCP server: exposes the agent WALLET tools (list_services / subscribe / unsubscribe /
// budget_status) over MCP, pointed at the FIXED token-package plan from token-plan-setup. The agent
// SUBSCRIBES live via Claude; the keeper (`npm run keeper -- <mandateId>`) charges it on interval.
// Requires scripts/.token-agent.json. Launched by isub-claude.ts when ISUB_TOKEN_AGENT=1.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubClient, keypairSigner, ChargeMode } from '../src/index';
import { IsubAgent, agentTools } from '../src/agent';
import { serveStdio } from '../src/mcp';
import { clientFor } from './env';
import type { Network } from './env';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, '.token-agent.json');

interface Cfg {
  network: Network;
  packageId: string;
  planId: string;
  merchant: string;
  keeper: string;
  accountId: string;
  agentSecretKey: string;
  service: string;
  price: string;
  intervalMs: string;
}

async function main(): Promise<void> {
  let cfg: Cfg;
  try { cfg = JSON.parse(readFileSync(CONFIG, 'utf8')) as Cfg; }
  catch { throw new Error('no scripts/.token-agent.json — run `npm run token-plan:setup` first'); }

  const client = clientFor(cfg.network);
  const isub = new IsubClient({ client, packageId: cfg.packageId });
  const signer = keypairSigner(Ed25519Keypair.fromSecretKey(cfg.agentSecretKey), client);
  const agent = new IsubAgent(isub, signer, {
    accountId: cfg.accountId,
    allowed: [
      {
        name: cfg.service,
        planId: cfg.planId,
        merchant: cfg.merchant,
        mode: ChargeMode.Fixed,
        price: BigInt(cfg.price),
        intervalMs: BigInt(cfg.intervalMs),
        maxTotalBudget: BigInt(cfg.price) * 1000n, // generous human-approved cap; the live subscribe picks a smaller budget
      },
    ],
  });

  await serveStdio({ walletTools: agentTools(agent), name: 'isub' });
  console.error(`[isub-token-agent] serving wallet tools (list_services/subscribe/budget_status) for "${cfg.service}"`);
}

main().catch((e) => { console.error('isub-token-agent failed:', e instanceof Error ? e.message : e); process.exit(1); });

// Non-interactive validation + demo fallback for scenario 4 (agent subscribes to a FIXED token
// package, keeper charges on interval). Loads .token-agent.json, has the IsubAgent SUBSCRIBE (the
// exact call the MCP `subscribe` tool makes), then runs the keeper until the first FIXED charge lands
// and asserts on-chain spent rose — proving the whole path on testnet without Claude in the loop.
// Run: ISUB_NETWORK=testnet npm run token:smoke
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubClient, IsubKeeper, keypairSigner, ChargeMode } from '../src/index';
import { IsubAgent } from '../src/agent';
import { fileStore } from '../src/store-file';
import { clientFor, loadOrCreateActor, fmt, explorer, sleep, NETWORK } from './env';
import type { Network } from './env';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, '.token-agent.json');

let checks = 0;
const check = (c: boolean, l: string): void => { if (!c) throw new Error('✗ ' + l); checks++; console.log('  ✓ ' + l); };

interface Cfg {
  network: Network; packageId: string; planId: string; merchant: string; keeper: string;
  accountId: string; agentSecretKey: string; service: string; price: string; intervalMs: string;
}

async function main(): Promise<void> {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8')) as Cfg;
  const client = clientFor();
  const isub = new IsubClient({ client, packageId: cfg.packageId });
  const ex = explorer();
  const price = BigInt(cfg.price);

  const agent = new IsubAgent(isub, keypairSigner(Ed25519Keypair.fromSecretKey(cfg.agentSecretKey), client), {
    accountId: cfg.accountId,
    allowed: [{ name: cfg.service, planId: cfg.planId, merchant: cfg.merchant, mode: ChargeMode.Fixed, price, intervalMs: BigInt(cfg.intervalMs), maxTotalBudget: price * 1000n }],
  });

  console.log(`• agent subscribes to "${cfg.service}" (FIXED) — the exact call the MCP subscribe tool makes`);
  const sub = await agent.subscribe({ service: cfg.service, budget: price * 5n });
  if (!sub.ok || !sub.mandateId) throw new Error('subscribe failed: ' + sub.reason);
  check(sub.mode === 'fixed' && sub.terms === 'approved', `subscribed → mandate ${sub.mandateId.slice(0, 12)}… (fixed, approved)`);
  const mandateId = sub.mandateId;

  const before = (await isub.getMandate(mandateId)).spentTotal;
  console.log('• keeper charges the FIXED mandate on interval (real on-chain charge on testnet)…');
  const keeperKp = loadOrCreateActor('keeper', cfg.network);
  const store = fileStore(join(here, '..', '.keeper', `${cfg.network}-tokensmoke`));
  let charged = false;
  let digest = '';
  const keeper = new IsubKeeper(isub, keypairSigner(keeperKp, client), [mandateId], {
    store,
    onEvent: (e) => {
      if (e.type === 'charge.succeeded') { charged = true; digest = e.digest; console.log(`  ✓ keeper charged ${fmt(e.amount)} (${e.digest.slice(0, 10)}…)`); }
      else if (e.type === 'charge.failed') console.log(`  · ${e.deterministic ? 'abort #' + e.abortCode : 'transient'}: ${e.error}`);
    },
  });
  await keeper.init();
  const ac = new AbortController();
  void keeper.run({ pollMs: 1000, signal: ac.signal });
  for (let i = 0; i < 40 && !charged; i++) await sleep(1000);
  ac.abort();
  await sleep(300);

  check(charged, 'keeper landed a real FIXED charge on testnet');
  const after = (await isub.getMandate(mandateId)).spentTotal;
  check(after > before, `on-chain spent rose ${fmt(before)} → ${fmt(after)}`);
  if (digest) console.log(`  explorer: ${ex.tx(digest)}`);

  console.log(`\n✅ token-agent smoke passed — ${checks} assertions. Agent subscribed to a FIXED plan + keeper charged it on testnet (scenario 4 is real).`);
  process.exit(0);
}

main().catch((e) => { console.error('\n✗ token-agent smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });

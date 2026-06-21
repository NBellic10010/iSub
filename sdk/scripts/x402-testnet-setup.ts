// ONE-TIME testnet setup for the Claude-CLI x402 demo — real on-chain settlement.
// Creates a real PAYG plan + funded Account + Mandate, generates a fresh agent key, and has the
// subscriber sign an AgentCert binding that key. Writes scripts/.x402-testnet.json (gitignored —
// contains the agent secret) for the server to load. Re-run only to mint a fresh mandate.
//
// Run: ISUB_NETWORK=testnet NODE_OPTIONS=--experimental-sqlite npx tsx scripts/x402-testnet-setup.ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubClient, keypairSigner, ChargeMode } from '../src/index';
import { IsubAgent } from '../src/agent';
import { issueAgentCert } from '../src/agent-auth';
import { clientFor, loadOrCreateActor, loadDeployment, suiBalance, sleep, fmt, explorer, NETWORK } from './env';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, '.x402-testnet.json');
const SUI = 1_000_000_000n;
const BUDGET = (5n * SUI) / 100n; // 0.05 SUI lifetime cap
const DEPOSIT = (8n * SUI) / 100n; // 0.08 SUI funded into the Account
const WINDOW_MS = 3_600_000n; // big window → rate cap doesn't bite the demo
const PRICES = [
  { path: '/weather', price: (SUI / 1000n).toString(), label: 'Weather forecast (per call)' }, // 0.001 SUI
  { path: '/premium-quote', price: ((5n * SUI) / 1000n).toString(), label: 'Premium stock quote (per call)' }, // 0.005 SUI
];

async function fundFromMerchant(client: ReturnType<typeof clientFor>, merchantKp: Ed25519Keypair, to: string, amount: bigint, label: string): Promise<void> {
  const tx = new Transaction();
  const [c] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([c], to);
  const r = await client.signAndExecuteTransaction({ transaction: tx, signer: merchantKp, include: { effects: true } });
  const t = r.$kind === 'Transaction' ? r.Transaction : r.FailedTransaction;
  await client.waitForTransaction({ digest: t.digest });
  console.log(`  funded ${label} with ${fmt(amount)}`);
}

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const ex = explorer();
  console.log(`• network ${NETWORK} · package ${packageId}`);

  const subKp = loadOrCreateActor('subscriber', NETWORK);
  const merchantKp = loadOrCreateActor('merchant', NETWORK);
  const keeperKp = loadOrCreateActor('keeper', NETWORK);
  const subscriber = keypairSigner(subKp, client);
  const merchant = keypairSigner(merchantKp, client);
  const keeper = keypairSigner(keeperKp, client);
  const agentKp = new Ed25519Keypair(); // fresh agent key (its secret goes into the gitignored config)

  // Fund subscriber (deposit source) + keeper (signs charge_metered → needs gas) from the merchant.
  if ((await suiBalance(client, subscriber.address)) < DEPOSIT + SUI / 5n) await fundFromMerchant(client, merchantKp, subscriber.address, (3n * SUI) / 10n, 'subscriber');
  if ((await suiBalance(client, keeper.address)) < SUI / 20n) await fundFromMerchant(client, merchantKp, keeper.address, SUI / 10n, 'keeper (gas)');

  console.log('• merchant publishes PAYG plan + agent subscribes (real Mandate)');
  const { planId } = await isub.createPlanPayg(merchant, { rateCap: BUDGET, rateWindowMs: WINDOW_MS, keeper: keeper.address });
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  const agent = new IsubAgent(isub, subscriber, {
    accountId,
    allowed: [{ name: 'x402-demo', planId, merchant: merchant.address, mode: ChargeMode.Payg, rateCap: BUDGET, rateWindowMs: WINDOW_MS, keeper: keeper.address, maxTotalBudget: BUDGET, maxPerCharge: BUDGET }],
  });
  const sub = await agent.subscribe({ service: 'x402-demo', budget: BUDGET });
  if (!sub.ok || !sub.mandateId) throw new Error(`subscribe failed: ${sub.reason}`);
  const mandateId = sub.mandateId;

  console.log('• subscriber signs the agent-key binding cert (PoP authorization)');
  const cert = await issueAgentCert(subKp, { mandateId, agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 });

  const cfg = {
    network: NETWORK,
    packageId,
    mandateId,
    accountId,
    payoutAddress: merchant.address,
    agentSecretKey: agentKp.getSecretKey(), // bech32 suiprivkey — SECRET (file is gitignored)
    cert: { agent: cert.agent, notAfter: cert.notAfter.toString(), ver: cert.ver, sig: cert.sig },
    asset: '0x2::sui::SUI',
    apis: PRICES,
  };
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');

  await sleep(NETWORK === 'localnet' ? 500 : 2000); // let not_before (on-chain Clock) clear before any charge

  console.log(`\n✅ testnet demo ready — mandate ${mandateId}`);
  console.log(`   spent/budget: 0 / ${fmt(BUDGET)} · deposit ${fmt(DEPOSIT)} · agent ${agentKp.toSuiAddress().slice(0, 12)}…`);
  console.log(`   suiscan: ${ex.object(mandateId)}`);
  console.log(`   config:  scripts/.x402-testnet.json (gitignored)`);
  console.log(`\n下一步:  npm run isub:claude:testnet     # 打开 Claude CLI,真链结算`);
}

main().catch((e) => { console.error('\n✗ x402-testnet-setup failed:', e instanceof Error ? e.message : e); process.exit(1); });

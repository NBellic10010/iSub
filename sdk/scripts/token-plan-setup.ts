// Scenario 4 setup: a merchant publishes a recurring FIXED "token package" plan (keeper = the keeper
// ACTOR, so `npm run keeper` can settle it), opens + funds a dedicated AGENT account, and writes
// scripts/.token-agent.json (gitignored — holds the agent key). The agent then SUBSCRIBES live via
// Claude (npm run isub:claude:token); run the keeper to charge it on interval.
// Run: ISUB_NETWORK=testnet npx tsx scripts/token-plan-setup.ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubClient, keypairSigner } from '../src/index';
import { clientFor, loadOrCreateActor, loadDeployment, suiBalance, fmt, explorer, NETWORK } from './env';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, '.token-agent.json');
const SUI = 1_000_000_000n;
const PRICE = SUI / 100n; // 0.01 SUI per period
const INTERVAL_MS = 5_000n; // 5s — recurring FIXED charge fires on camera (matches the web test interval)
const DEPOSIT = (3n * SUI) / 10n; // 0.3 SUI into the agent account (≈30 periods)
const KEEPER_GAS = SUI / 10n; // 0.1 SUI for the keeper to sign charges
const SERVICE = 'Pro token package';

async function fund(client: ReturnType<typeof clientFor>, fromKp: Ed25519Keypair, to: string, amount: bigint, label: string): Promise<void> {
  const tx = new Transaction();
  const [c] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([c], to);
  const r = await client.signAndExecuteTransaction({ transaction: tx, signer: fromKp, include: { effects: true } });
  const t = r.$kind === 'Transaction' ? r.Transaction : r.FailedTransaction;
  await client.waitForTransaction({ digest: t.digest });
  console.log(`  funded ${label} ${fmt(amount)}`);
}

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const ex = explorer();
  console.log(`• network ${NETWORK} · package ${packageId}`);

  const merchantKp = loadOrCreateActor('merchant', NETWORK);
  const keeperKp = loadOrCreateActor('keeper', NETWORK); // same key `npm run keeper` loads
  const agentKp = loadOrCreateActor('token-agent', NETWORK); // the agent's own account owner
  const merchant = keypairSigner(merchantKp, client);
  const agent = keypairSigner(agentKp, client);

  const mBal = await suiBalance(client, merchant.address);
  if (mBal < DEPOSIT + KEEPER_GAS + SUI / 5n) {
    throw new Error(`merchant ${merchant.address} is low (${fmt(mBal)}). Faucet it: https://faucet.sui.io/?address=${merchant.address}`);
  }
  if ((await suiBalance(client, agent.address)) < DEPOSIT + SUI / 20n) await fund(client, merchantKp, agent.address, DEPOSIT + SUI / 10n, 'token-agent (deposit + gas)');
  if ((await suiBalance(client, keeperKp.toSuiAddress())) < SUI / 20n) await fund(client, merchantKp, keeperKp.toSuiAddress(), KEEPER_GAS, 'keeper (gas)');

  console.log('• merchant publishes a FIXED token-package plan (keeper = keeper actor)');
  const { planId } = await isub.createPlanFixed(merchant, { price: PRICE, intervalMs: INTERVAL_MS, keeper: keeperKp.toSuiAddress() });

  console.log('• open + fund the agent account');
  const { accountId } = await isub.openAccount(agent);
  await isub.deposit(agent, { accountId, amount: DEPOSIT });

  const cfg = {
    network: NETWORK,
    packageId,
    planId,
    merchant: merchant.address,
    keeper: keeperKp.toSuiAddress(),
    accountId,
    agentSecretKey: agentKp.getSecretKey(), // bech32 suiprivkey — SECRET (file is gitignored)
    service: SERVICE,
    price: PRICE.toString(),
    intervalMs: INTERVAL_MS.toString(),
  };
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');

  console.log(`\n✅ token plan ready`);
  console.log(`   planId:   ${planId}`);
  console.log(`   service:  "${SERVICE}" · ${fmt(PRICE)} / ${Number(INTERVAL_MS) / 1000}s (FIXED)`);
  console.log(`   agent:    ${agent.address}`);
  console.log(`   account:  ${accountId} (deposit ${fmt(DEPOSIT)})`);
  console.log(`   keeper:   ${keeperKp.toSuiAddress()}`);
  console.log(`   suiscan:  ${ex.object(planId)}`);
  console.log(`   config:   scripts/.token-agent.json (gitignored)`);
  console.log(`\n下一步:`);
  console.log(`   1) npm run isub:claude:token   # Claude: "list services" → "subscribe to the Pro token package, budget 0.1 SUI"`);
  console.log(`   2) 复制返回的 mandateId,另开终端: ISUB_NETWORK=testnet npm run keeper -- 0x<mandateId>`);
  console.log(`   3) 回 Claude: "what's my budget status?"  → spent 每 ${Number(INTERVAL_MS) / 1000}s 上涨`);
  console.log(`   (非交互验证/兜底: ISUB_NETWORK=testnet npm run token:smoke)`);
}

main().catch((e) => { console.error('\n✗ token-plan-setup failed:', e instanceof Error ? e.message : e); process.exit(1); });

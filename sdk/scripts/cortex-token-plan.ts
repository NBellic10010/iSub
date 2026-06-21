// Cortex demo: publish a recurring FIXED "token package" plan that charges every 10s at a small
// price — for the BROWSER checkout demo (checkout/cortex.html). The merchant publishes it with
// keeper = the keeper ACTOR (the key `npm run keeper` loads), so after a user subscribes through the
// Cortex "Subscribe with Sui" popup you can settle it on interval:
//   ISUB_NETWORK=testnet npm run keeper -- 0x<mandateId>
// Then drop the printed planId into checkout/cortex.html's Token-package cards (data-plan).
//
// Unlike token-plan-setup.ts (the CLAUDE-agent flow — opens/funds an agent account + writes
// .token-agent.json), this only publishes the plan + tops up keeper gas: in Cortex the SUBSCRIBER is
// a human wallet, so there's no agent account to provision here.
// Run: ISUB_NETWORK=testnet npx tsx scripts/cortex-token-plan.ts
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubClient, keypairSigner } from '../src/index';
import { clientFor, loadOrCreateActor, loadDeployment, suiBalance, fmt, explorer, NETWORK } from './env';

const SUI = 1_000_000_000n;
const PRICE = SUI / 100n; // 0.01 SUI per period — 小额 (a subscriber's 0.1 SUI budget ≈ 10 charges = ~100s of demo)
const INTERVAL_MS = 10_000n; // 10s — the recurring FIXED charge fires every 10s, on camera
const KEEPER_GAS = SUI / 10n; // 0.1 SUI so the keeper can sign ~hundreds of charges
const SERVICE = 'Cortex token package (10s demo)';

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
  const merchant = keypairSigner(merchantKp, client);

  const mBal = await suiBalance(client, merchant.address);
  if (mBal < KEEPER_GAS + SUI / 5n) {
    throw new Error(`merchant ${merchant.address} is low (${fmt(mBal)}). Faucet it: https://faucet.sui.io/?address=${merchant.address}`);
  }
  if ((await suiBalance(client, keeperKp.toSuiAddress())) < SUI / 20n) await fund(client, merchantKp, keeperKp.toSuiAddress(), KEEPER_GAS, 'keeper (gas)');

  console.log(`• merchant publishes a FIXED token-package plan (${Number(INTERVAL_MS) / 1000}s interval, keeper = keeper actor)`);
  const { planId } = await isub.createPlanFixed(merchant, { price: PRICE, intervalMs: INTERVAL_MS, keeper: keeperKp.toSuiAddress() });

  console.log(`\n✅ Cortex 10s token plan ready`);
  console.log(`   planId:   ${planId}`);
  console.log(`   service:  "${SERVICE}" · ${fmt(PRICE)} / ${Number(INTERVAL_MS) / 1000}s (FIXED)`);
  console.log(`   merchant: ${merchant.address}`);
  console.log(`   keeper:   ${keeperKp.toSuiAddress()}`);
  console.log(`   suiscan:  ${ex.object(planId)}`);
  console.log(`\n下一步:`);
  console.log(`   1) 把 planId 填进 checkout/cortex.html 的 Token-package 卡片 data-plan(本脚本运行后我会替你写好)`);
  console.log(`   2) 起 Cortex 站点 (cd checkout && npm run dev),点 "Subscribe with Sui" 用钱包订阅 → 复制返回的 mandateId`);
  console.log(`   3) 另开终端定时扣款: ISUB_NETWORK=testnet npm run keeper -- 0x<mandateId>  → spent 每 ${Number(INTERVAL_MS) / 1000}s 上涨`);
  console.log(`   (用户端 /app 连同一钱包即可看到这条订阅 + 用量随扣款增长)`);
}

main().catch((e) => { console.error('\n✗ cortex-token-plan failed:', e instanceof Error ? e.message : e); process.exit(1); });

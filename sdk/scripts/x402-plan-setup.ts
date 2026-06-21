// Publish the demo PAYG plan so a USER (browser wallet) can subscribe to it and become the mandate
// subscriber — the path that makes x402 charges show up on the user's own dashboard. The plan's keeper
// is the `keeper` actor (the same one x402-testnet-agent-setup loads), so the CLI agent can settle.
//
// Flow:  npm run x402-plan:setup  → copy planId
//   → browser dashboard: "Track a mandate" panel → paste planId → Review terms → Subscribe (your wallet)
//   → on the new PAYG card: "Export x402 agent config" → save JSON to scripts/.x402-testnet.json
//   → npm run isub:claude:testnet
//
// Run: ISUB_NETWORK=testnet NODE_OPTIONS=--experimental-sqlite npx tsx scripts/x402-plan-setup.ts
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubClient, keypairSigner } from '../src/index';
import { clientFor, loadOrCreateActor, loadDeployment, suiBalance, fmt, explorer, NETWORK } from './env';

const SUI = 1_000_000_000n;
const RATE_CAP = (2n * SUI) / 10n; // 0.2 SUI per window — generous so the rate cap never bites the demo
const WINDOW_MS = 3_600_000n; // 1h window
const KEEPER_GAS = SUI / 10n; // 0.1 SUI for the keeper to sign charge_metered

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

  const merchantKp = loadOrCreateActor('merchant', NETWORK);
  const keeperKp = loadOrCreateActor('keeper', NETWORK);
  const merchant = keypairSigner(merchantKp, client);
  const keeper = keypairSigner(keeperKp, client);

  const merchBal = await suiBalance(client, merchant.address);
  if (merchBal < KEEPER_GAS + SUI / 5n) {
    throw new Error(`merchant ${merchant.address} is low (${fmt(merchBal)}). Faucet it: https://faucet.sui.io/?address=${merchant.address}`);
  }
  // Keeper signs charge_metered → needs gas. Top it up from the merchant.
  if ((await suiBalance(client, keeper.address)) < SUI / 20n) await fundFromMerchant(client, merchantKp, keeper.address, KEEPER_GAS, 'keeper (gas)');

  console.log('• merchant publishes PAYG plan (keeper = keeper actor)');
  const { planId, digest } = await isub.createPlanPayg(merchant, { rateCap: RATE_CAP, rateWindowMs: WINDOW_MS, keeper: keeper.address });

  console.log(`\n✅ PAYG plan published`);
  console.log(`   planId:   ${planId}`);
  console.log(`   merchant: ${merchant.address}  (mandate payout)`);
  console.log(`   keeper:   ${keeper.address}  (settles charge_metered)`);
  console.log(`   rateCap:  ${fmt(RATE_CAP)} / ${Number(WINDOW_MS) / 3_600_000}h`);
  console.log(`   suiscan:  ${ex.tx(digest)}`);
  console.log(`\n下一步:`);
  console.log(`   1) 浏览器面板(npm run dev, web/),用你的钱包: "Track a mandate" → 粘 planId → Review terms → Subscribe`);
  console.log(`   2) 新出的 PAYG 卡片上点 "Export x402 agent config" → 把 JSON 存到 sdk/scripts/.x402-testnet.json`);
  console.log(`   3) cd sdk && npm run isub:claude:testnet     # Claude 付款 → 你自己的面板出柱`);
  console.log(`\n   注意: 你的账户要有余额(面板 Deposit),keeper 才能从中扣款。`);
}

main().catch((e) => { console.error('\n✗ x402-plan-setup failed:', e instanceof Error ? e.message : e); process.exit(1); });

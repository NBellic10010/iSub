// Seed REAL testnet PAYG usage + on-chain charges into the gateway's file DB, so the web
// UsageChart (GET /usage?mandateId / /charges?mandateId) has live data to render. Mirrors the
// agent-PAYG demo: merchant publishes a PAYG plan, an agent autonomously subscribes (real
// Mandate), a metered service reports token usage (useMetered) + settles on-chain, and the
// mandate/account/plan are ingested into the relationship index for dashboard discovery.
//
// Run: `ISUB_NETWORK=testnet NODE_OPTIONS=--experimental-sqlite tsx scripts/chart-seed.ts`
// Then serve the same DB:  ISUB_NETWORK=testnet npm run gateway:serve   (reads isub-index.testnet.db)
import { Transaction } from '@mysten/sui/transactions';
import { IsubClient, keypairSigner, ChargeMode, type RateCard } from '../src/index';
import { IsubAgent } from '../src/agent';
import { IsubService } from '../src/service';
import { IsubIndex } from '../src/relations';
import { openDb } from '../src/db';
import { registerMerchant, sqlBillerStore, usageByMandate, chargesByMandate } from '../src/sql-store';
import { clientFor, loadOrCreateActor, loadDeployment, suiBalance, sleep, fmt, explorer, NETWORK } from './env';

const SUI = 1_000_000_000n;
const BUDGET = (5n * SUI) / 100n; // 0.05 SUI lifetime
const DEPOSIT = (8n * SUI) / 100n; // 0.08 SUI funded
const WINDOW_MS = 3_600_000n; // huge → one deterministic flush settles the batch
const DB_PATH = process.env.ISUB_INDEX_DB ?? `isub-index.${NETWORK}.db`;
const API_KEY = 'sk_chart_seed';

// Merchant price list: a realistic per-token card. Calls below stay < maxPerCharge & sum < budget.
const CARD: RateCard = {
  version: 1,
  meters: {
    'tokens.in': { key: 'tokens.in', priceNum: 200_000n, priceDen: 1n, units: 1000n }, // 0.2 SUI / 1M in-tokens
    'tokens.out': { key: 'tokens.out', priceNum: 600_000n, priceDen: 1n, units: 1000n }, // 0.6 SUI / 1M out-tokens
  },
};
// Three varied metered calls → three varied bars on the chart.
const CALLS = [
  [{ meterKey: 'tokens.in', qty: 50_000n }, { meterKey: 'tokens.out', qty: 10_000n }], // 0.016
  [{ meterKey: 'tokens.in', qty: 30_000n }], // 0.006
  [{ meterKey: 'tokens.in', qty: 80_000n }, { meterKey: 'tokens.out', qty: 5_000n }], // 0.019
];

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const ex = explorer();
  console.log(`• network: ${NETWORK} ｜ package ${packageId} ｜ db ${DB_PATH}`);

  // load persistent actors WITHOUT the faucet floor (testnet faucet is rate-limited); we rebalance
  // from the merchant ourselves so the agent key can cover the deposit + gas.
  const subKp = loadOrCreateActor('subscriber', NETWORK);
  const merchantKp = loadOrCreateActor('merchant', NETWORK);
  const keeperKp = loadOrCreateActor('keeper', NETWORK);
  const subscriber = keypairSigner(subKp, client);
  const merchant = keypairSigner(merchantKp, client);
  const keeper = keypairSigner(keeperKp, client);

  if ((await suiBalance(client, subscriber.address)) < DEPOSIT + SUI / 10n) {
    console.log('• funding subscriber from merchant (0.3 SUI)…');
    const tx = new Transaction();
    const [c] = tx.splitCoins(tx.gas, [(3n * SUI) / 10n]);
    tx.transferObjects([c], subscriber.address);
    const r = await client.signAndExecuteTransaction({ transaction: tx, signer: merchantKp, include: { effects: true } });
    const t = r.$kind === 'Transaction' ? r.Transaction : r.FailedTransaction;
    await client.waitForTransaction({ digest: t.digest });
    console.log(`  subscriber now ${fmt(await suiBalance(client, subscriber.address))}`);
  }

  const db = openDb(DB_PATH);
  registerMerchant(db, { id: 'acme', name: 'Acme GPU API', apiKey: API_KEY, payoutAddress: merchant.address });

  console.log('\n• merchant 建 PAYG plan + agent 自主订阅(真 Mandate)');
  const { planId } = await isub.createPlanPayg(merchant, { rateCap: BUDGET, rateWindowMs: WINDOW_MS, keeper: keeper.address });
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  const agent = new IsubAgent(isub, subscriber, {
    accountId,
    allowed: [{ name: 'gpu-api', planId, merchant: merchant.address, mode: ChargeMode.Payg, rateCap: BUDGET, rateWindowMs: WINDOW_MS, keeper: keeper.address, maxTotalBudget: BUDGET, maxPerCharge: BUDGET }],
  });
  const sub = await agent.subscribe({ service: 'gpu-api', budget: BUDGET });
  if (!sub.ok || !sub.mandateId) throw new Error(`subscribe failed: ${sub.reason}`);
  const mandateId = sub.mandateId;
  console.log(`  mandate ${mandateId}`);

  console.log('• 服务计量 token 用量(useMetered ×3)+ 链上结算');
  const svc = new IsubService(isub, keeper, merchant.address, sqlBillerStore(db, 'acme'), { windowMs: Number(WINDOW_MS) }, undefined, CARD);
  const runId = Date.now().toString(36); // usageId is unique per (merchant, usageId) — make it unique per run
  for (let i = 0; i < CALLS.length; i++) {
    const r = await svc.useMetered(mandateId, CALLS[i]!, `call-${runId}-${i}`);
    console.log(`  call-${i}: ${r.ok ? 'served 200' : `gated ${r.status} (${r.reason})`}`);
  }
  // not_before is stamped from the on-chain Clock (which runs slightly ahead of local time); wait so
  // the biller's LOCAL spendableNow gate clears not_before before the first flush (same skew the
  // pricing-smoke handles). Without this the immediate flush conservatively carries → charges 0.
  await sleep(2500);
  await svc.flush(mandateId); // on-chain charge_metered (keeper-signed)
  const m = await isub.getMandate(mandateId);
  console.log(`  on-chain spent_total ${fmt(m.spentTotal)} · charge_seq ${m.chargeSeq}`);

  console.log('• 写入关系索引(供面板按钱包发现)');
  const index = new IsubIndex(isub, db);
  await index.ingestPlan(planId);
  await index.ingestMandate(mandateId);
  await index.ingestAccount(accountId);

  // self-verify: the EXACT functions the gateway's /usage and /charges endpoints call
  const usage = usageByMandate(db, mandateId);
  const charges = chargesByMandate(db, mandateId);
  console.log('\n• 自验(网关 /usage、/charges 读的就是这两个):');
  console.log(`  usageByMandate → ${usage.length} 条计量记录`);
  console.log(`  chargesByMandate → ${charges.length} 条结算日志`);
  if (usage.length !== CALLS.length) throw new Error(`expected ${CALLS.length} usage rows, got ${usage.length}`);
  if (charges.filter((c) => c.kind === 'charged').length < 1) throw new Error('expected ≥1 charged entry');

  db.close();
  console.log(`\n✅ seeded — UsageChart 数据已写入 ${DB_PATH}`);
  console.log('  下一步:  ISUB_NETWORK=testnet npm run gateway:serve   (起读 API,读同一个 db)');
  console.log(`  图表端点: GET /usage?mandateId=${mandateId}`);
  console.log(`  面板发现: GET /relations/mandates?subscriber=${subscriber.address}`);
  console.log(`  explorer  mandate ${ex.object(mandateId)}`);
  console.log(`\nMANDATE_ID=${mandateId}`);
  console.log(`SUBSCRIBER=${subscriber.address}`);
}

main().catch((e) => {
  console.error('\n✗ chart-seed failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

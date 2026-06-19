// PAYG pricing-layer e2e on a REAL network. An agent reports RAW usage QUANTITIES
// (input/output tokens + a per-call fee); the merchant's RateCard prices them off-chain;
// the biller settles on-chain via the real `charge_metered`; and we assert the on-chain
// debit equals the off-chain priced amount to the MIST. Then: duplicate usageId never
// double-charges, and cumulative spend == the sum of priced calls.
//
// Run: `npm run pricing:smoke` (localnet) or `npm run pricing-smoke:testnet`.
import { IsubClient, keypairSigner, priceUsageMulti, type RateCard } from '../src/index';
import { IsubBiller, memBillerStore } from '../src/biller';
import { clientFor, actor, suiBalance, loadDeployment, fmt, sleep, explorer, NETWORK } from './env';

const LOCAL = NETWORK === 'localnet';
const SUI = 1_000_000_000n;
const DEPOSIT = (3n * SUI) / 10n; // 0.3 SUI allowance the human funds the agent account with
const RATE_CAP = SUI / 10n; // 0.10 SUI per rolling window
const WINDOW_MS = LOCAL ? 3_000n : 12_000n;
const BUDGET = SUI / 5n; // 0.20 SUI lifetime cap

// The merchant's CUSTOM price list (all MIST). Different merchants ship different cards.
const CARD: RateCard = {
  version: 1,
  meters: {
    'tokens.in': { key: 'tokens.in', priceNum: 400_000n, priceDen: 1n, units: 1000n }, // 0.4 SUI / 1M input tokens
    'tokens.out': { key: 'tokens.out', priceNum: 1_200_000n, priceDen: 1n, units: 1000n }, // 1.2 SUI / 1M output tokens
    'calls': { key: 'calls', priceNum: 1_000_000n, priceDen: 1n, units: 1n }, // 0.001 SUI flat per request
  },
};

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}
function eqBig(a: bigint, b: bigint, label: string): void {
  check(a === b, `${label} — ${fmt(a)} == ${fmt(b)}`);
}

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const ex = explorer();
  console.log(`• network: ${NETWORK} ｜ package ${packageId}`);

  console.log('• funding actors (agent / service-merchant / service-keeper)…');
  const [agentKp, merchantKp, keeperKp] = await Promise.all([actor(client, 'subscriber'), actor(client, 'merchant'), actor(client, 'keeper')]);
  const agent = keypairSigner(agentKp, client); // owns the funded Account
  const merchant = keypairSigner(merchantKp, client); // the paid service
  const keeper = keypairSigner(keeperKp, client); // the authorized charger (iSub's keeper, in the managed model)

  console.log('\n• setup: account + PAYG plan + metered mandate');
  const { accountId } = await isub.openAccount(agent);
  await isub.deposit(agent, { accountId, amount: DEPOSIT });
  const { planId } = await isub.createPlanPayg(merchant, { rateCap: RATE_CAP, rateWindowMs: WINDOW_MS, keeper: keeper.address });
  const expiryMs = BigInt(Date.now() + 60 * 60 * 1000);
  const { mandateId } = await isub.authorizeMetered(agent, {
    accountId, planId, expectedRateCap: RATE_CAP, expectedRateWindowMs: WINDOW_MS,
    expectedMerchant: merchant.address, expectedKeeper: keeper.address,
    totalBudget: BUDGET, expiryMs, maxPerCharge: RATE_CAP,
  });
  console.log(`  account ${accountId.slice(0, 10)}… funded ${fmt(DEPOSIT)} · mandate ${mandateId.slice(0, 10)}…`);

  // `not_before_ms` is stamped from the on-chain Clock at authorize, which can run slightly AHEAD
  // of the local wall clock. The biller's `spendableNow` gate is local, so an immediate flush would
  // conservatively skip ("not chargeable yet") on that skew. A real biller flushes on a window loop;
  // here we wait a beat so local time clears not_before before the first flush.
  await sleep(LOCAL ? 500 : 2500);

  // The pricing layer drives settlement: biller holds the merchant's RateCard, signs as keeper.
  const store = memBillerStore();
  const biller = new IsubBiller(isub, keeper, store, { rateCard: CARD });

  // ===== call #1: a real-looking LLM request, reported as RAW quantities =====
  console.log('\n• agent reports usage for call-1 (raw quantities, not amounts):');
  const call1 = [
    { meterKey: 'tokens.in', qty: 50_000n },
    { meterKey: 'tokens.out', qty: 10_000n },
    { meterKey: 'calls', qty: 1n },
  ];
  const q1 = priceUsageMulti(CARD, call1); // off-chain expectation (the same code the biller runs at ingest)
  for (const l of q1.lines) console.log(`    ${l.meterKey.padEnd(11)} ${l.qty.toString().padStart(7)} → ${fmt(l.amount)}`);
  console.log(`    RateCard prices it → ${fmt(q1.amount)} (frozen at ingest)`);
  await biller.recordMeteredUsage({ mandateId, usageId: 'call-1', items: call1 });

  const acctBefore = (await isub.getAccount(accountId)).balance;
  const merchBefore = await suiBalance(client, merchant.address);
  console.log('• biller flush → on-chain charge_metered (keeper-signed)');
  const [r1] = await biller.flush(mandateId, Date.now());
  eqBig(r1!.charged, q1.amount, 'on-chain charge == off-chain RateCard price');
  eqBig((await isub.getAccount(accountId)).balance, acctBefore - q1.amount, 'account debited by exactly the priced amount');
  eqBig((await suiBalance(client, merchant.address)) - merchBefore, q1.amount, 'merchant received exactly the priced amount');
  let m = await isub.getMandate(mandateId);
  eqBig(m.spentTotal, q1.amount, 'mandate spent_total == priced amount');
  eqBig(m.chargeSeq, 1n, 'charge_seq advanced to 1');

  // ===== duplicate usageId never double-charges (idempotent across the priced path too) =====
  console.log('\n• [negative] re-report the SAME usageId (call-1) → must not double-charge');
  await biller.recordMeteredUsage({ mandateId, usageId: 'call-1', items: call1 });
  const [rdup] = await biller.flush(mandateId, Date.now());
  eqBig(rdup!.charged, 0n, 'duplicate usageId charged nothing');
  eqBig((await isub.getMandate(mandateId)).spentTotal, q1.amount, 'spent_total unchanged after the duplicate');

  // ===== call #2: another priced request, cumulative on-chain spend =====
  console.log('\n• agent reports usage for call-2 (20,000 input tokens)');
  const call2 = [{ meterKey: 'tokens.in', qty: 20_000n }];
  const q2 = priceUsageMulti(CARD, call2);
  console.log(`    RateCard prices it → ${fmt(q2.amount)}`);
  await biller.recordMeteredUsage({ mandateId, usageId: 'call-2', items: call2 });
  const [r2] = await biller.flush(mandateId, Date.now());
  eqBig(r2!.charged, q2.amount, 'call-2 on-chain charge == priced amount');
  m = await isub.getMandate(mandateId);
  eqBig(m.spentTotal, q1.amount + q2.amount, 'cumulative spent_total == sum of the two priced calls');
  eqBig(m.chargeSeq, 2n, 'charge_seq advanced to 2');
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - q1.amount - q2.amount, 'account balance = deposit − all priced charges');

  console.log(`\n✅ pricing e2e passed — ${checks} assertions on ${NETWORK}`);
  console.log(`• total billed ${fmt(q1.amount + q2.amount)} of ${fmt(DEPOSIT)} · ${fmt(BUDGET - (q1.amount + q2.amount))} budget left`);
  console.log(`• explorer  mandate ${ex.object(mandateId)}`);
}

main().catch((e) => {
  console.error('\n❌ pricing e2e failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

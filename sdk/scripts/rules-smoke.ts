// Deduction-rule smoke: exercises the per-charge GUARD rails on a real chain — the rules that
// reject a bad charge — complementing smoke.ts (Fixed interval/status) and payg-smoke.ts
// (seq/mode/rate-cap/refund). Focused on the caps not otherwise hit on-chain:
//
//   Fixed:  wrong amount (≠ price)                      → EWrongAmount (#7)
//   Fixed:  correct amount                              → charges (happy)
//   PAYG:   amount > max_per_charge (user throttle)     → EOverMaxPerCharge (#24)
//   PAYG:   amount ≤ max_per_charge                     → charges (happy)
//   PAYG:   spent_total + amount > total_budget         → EOverTotalBudget (#9)
//
// PAYG window is set huge so the rate window never rolls over mid-test (the rate-cap rule itself
// is covered in payg-smoke). No interval/window waits → fast and deterministic.
//
// Run: `npm run rules:smoke` (localnet) or `npm run rules-smoke:testnet`.
import { IsubClient, keypairSigner, errorName, abortCodeOf } from '../src/index';
import { clientFor, actor, suiBalance, loadDeployment, fmt, explorer, NETWORK } from './env';

const SUI = 1_000_000_000n;
const DEPOSIT = (3n * SUI) / 10n; // 0.30 SUI

// Fixed plan
const PRICE = SUI / 20n; // 0.05 SUI per period
const WRONG = SUI / 25n; // 0.04 SUI — deliberately ≠ price
const FIXED_INTERVAL_MS = 2_000n; // irrelevant here (we never wait); kept small
const FIXED_BUDGET = SUI / 5n; // 0.20 SUI

// PAYG plan — large window so the rate window never rolls over during the test
const RATE_CAP = SUI / 10n; // 0.10 SUI per window
const BIG_WINDOW_MS = 600_000n; // 10 min
const MAX_PER_CHARGE = SUI / 25n; // 0.04 SUI — user's per-charge throttle
const OVER_MAX = SUI / 20n; // 0.05 SUI > max_per_charge, but < rate_cap
const PAYG_BUDGET = (6n * SUI) / 100n; // 0.06 SUI lifetime
const UNIT = SUI / 25n; // 0.04 SUI per metered charge (== max_per_charge, allowed)

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}
function eqBig(a: bigint, b: bigint, label: string): void {
  check(a === b, `${label} — ${fmt(a)} == ${fmt(b)}`);
}
async function expectAbort(p: Promise<unknown>, code: number, label: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const got = abortCodeOf(e);
    const msg = e instanceof Error ? e.message : String(e);
    check(got === code, `${label} → aborts ${errorName(code)} (#${code})${got === code ? '' : ` [got #${got}: ${msg}]`}`);
    return;
  }
  throw new Error(`✗ ${label}: expected abort ${errorName(code)} (#${code}) but the tx succeeded`);
}

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const ex = explorer();
  console.log(`• network: ${NETWORK} ｜ package ${packageId}`);

  console.log('• funding actors…');
  const [subKp, merchantKp, keeperKp] = await Promise.all([
    actor(client, 'subscriber'),
    actor(client, 'merchant'),
    actor(client, 'keeper'),
  ]);
  const subscriber = keypairSigner(subKp, client);
  const merchant = keypairSigner(merchantKp, client);
  const keeper = keypairSigner(keeperKp, client);

  console.log('\n• setup: account + deposit');
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT, 'account funded');
  const expiryMs = BigInt(Date.now() + 60 * 60 * 1000); // +1h

  // ===== Fixed: exact-amount rule =====
  console.log('\n• Fixed plan + authorize');
  const { planId: fixedPlan } = await isub.createPlanFixed(merchant, { price: PRICE, intervalMs: FIXED_INTERVAL_MS, keeper: keeper.address });
  const { mandateId: fixedMandate } = await isub.authorizeFixed(subscriber, {
    accountId, planId: fixedPlan, expectedPrice: PRICE, expectedIntervalMs: FIXED_INTERVAL_MS,
    expectedMerchant: merchant.address, totalBudget: FIXED_BUDGET, expiryMs,
  });

  console.log('\n• Fixed charge with WRONG amount (0.04 ≠ price 0.05) → expect EWrongAmount');
  await expectAbort(isub.charge(keeper, { accountId, mandateId: fixedMandate, amount: WRONG }), 7, 'wrong-amount charge');
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT, 'account unchanged after rejected charge');

  console.log('\n• Fixed charge with correct amount (0.05) → ok');
  await isub.charge(keeper, { accountId, mandateId: fixedMandate, amount: PRICE });
  eqBig((await isub.getMandate(fixedMandate)).spentTotal, PRICE, 'fixed spent_total = price');
  const afterFixed = DEPOSIT - PRICE;
  eqBig((await isub.getAccount(accountId)).balance, afterFixed, 'account debited by exactly price');

  // ===== PAYG: per-charge throttle + lifetime budget rules =====
  console.log('\n• PAYG plan + authorize (budget 0.06 · max_per_charge 0.04 · rate_cap 0.10)');
  const { planId: paygPlan } = await isub.createPlanPayg(merchant, { rateCap: RATE_CAP, rateWindowMs: BIG_WINDOW_MS, keeper: keeper.address });
  const { mandateId: paygMandate } = await isub.authorizeMetered(subscriber, {
    accountId, planId: paygPlan, expectedRateCap: RATE_CAP, expectedRateWindowMs: BIG_WINDOW_MS,
    expectedMerchant: merchant.address, expectedKeeper: keeper.address,
    totalBudget: PAYG_BUDGET, expiryMs, maxPerCharge: MAX_PER_CHARGE,
  });

  console.log('\n• metered charge 0.05 > max_per_charge 0.04 (under rate_cap) → expect EOverMaxPerCharge');
  await expectAbort(isub.chargeMetered(keeper, { accountId, mandateId: paygMandate, amount: OVER_MAX, seq: 0n }), 24, 'over-max-per-charge');
  eqBig((await isub.getMandate(paygMandate)).chargeSeq, 0n, 'seq not advanced by rejected charge');

  console.log('\n• metered charge 0.04 == max_per_charge → ok (seq 0)');
  await isub.chargeMetered(keeper, { accountId, mandateId: paygMandate, amount: UNIT, seq: 0n });
  eqBig((await isub.getMandate(paygMandate)).spentTotal, UNIT, 'payg spent_total = 0.04');

  console.log('\n• metered charge 0.04 more → spent 0.08 > budget 0.06 → expect EOverTotalBudget');
  await expectAbort(isub.chargeMetered(keeper, { accountId, mandateId: paygMandate, amount: UNIT, seq: 1n }), 9, 'over-total-budget');
  eqBig((await isub.getMandate(paygMandate)).spentTotal, UNIT, 'spent_total unchanged after budget block');
  eqBig((await isub.getAccount(accountId)).balance, afterFixed - UNIT, 'account only debited by the one allowed metered charge');

  console.log(`\n✅ rules smoke passed — ${checks} assertions on ${NETWORK}`);
  console.log('• covered: EWrongAmount #7 · EOverMaxPerCharge #24 · EOverTotalBudget #9 (+ happy charges)');
  console.log(`• explorer  fixed ${ex.object(fixedMandate)}`);
  console.log(`            payg  ${ex.object(paygMandate)}`);
}

main().catch((e) => {
  console.error('\n❌ rules smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

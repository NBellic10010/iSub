// PAYG + money-correctness smoke (N-1 idempotency, N-2 refund) on a real network.
//
//   metered charge ×2 (seq-gated) -> [negative] replay same seq / future seq /
//   legacy charge() on PAYG / over rate cap -> window rollover -> refund (partial)
//   -> [negative] refund over spent / refund by non-merchant
//
// Run: `npm run payg:smoke` (localnet) or `npm run payg-smoke:testnet`.
import { IsubClient, keypairSigner, errorName, abortCodeOf } from '../src/index';
import { clientFor, actor, suiBalance, loadDeployment, fmt, sleep, explorer, NETWORK } from './env';

const LOCAL = NETWORK === 'localnet';
const SUI = 1_000_000_000n;
const DEPOSIT = (3n * SUI) / 10n; // 0.3 SUI
const RATE_CAP = SUI / 10n; // 0.10 SUI per window
const WINDOW_MS = LOCAL ? 6_000n : 12_000n;
const BUDGET = SUI / 5n; // 0.2 SUI lifetime
const A1 = (3n * SUI) / 100n; // 0.03
const A2 = (8n * SUI) / 100n; // 0.08
const REFUND = SUI / 20n; // 0.05

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

  console.log('\n• setup: account + PAYG plan + authorize');
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  const { planId } = await isub.createPlanPayg(merchant, {
    rateCap: RATE_CAP,
    rateWindowMs: WINDOW_MS,
    keeper: keeper.address,
  });
  const expiryMs = BigInt(Date.now() + 60 * 60 * 1000);
  const { mandateId } = await isub.authorizeMetered(subscriber, {
    accountId, planId, expectedRateCap: RATE_CAP, expectedRateWindowMs: WINDOW_MS,
    expectedMerchant: merchant.address, expectedKeeper: keeper.address,
    totalBudget: BUDGET, expiryMs, maxPerCharge: RATE_CAP,
  });
  let m = await isub.getMandate(mandateId);
  eqBig(m.chargeSeq, 0n, 'fresh mandate chargeSeq = 0');

  // metered charge #1 — keeper-signed (authorized), so merchant balance deltas stay
  // gas-free and can be asserted exactly; merchant only signs refunds below.
  console.log('\n• charge_metered #1 (keeper, seq 0)');
  const merchBefore = await suiBalance(client, merchant.address);
  await isub.chargeMetered(keeper, { accountId, mandateId, amount: A1, seq: 0n });
  m = await isub.getMandate(mandateId);
  eqBig(m.chargeSeq, 1n, 'chargeSeq advanced to 1');
  eqBig(m.spentTotal, A1, 'spent_total = 0.03');
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - A1, 'account debited exactly');

  // rate cap — asserted IMMEDIATELY after charge #1 so it can't race the window rollover: this
  // must land in the SAME window as charge #1 (window_spent 0.03 + 0.08 > 0.10 cap). A failed
  // charge doesn't advance charge_seq, so seq stays 1 for the negative checks + charge #2 below.
  console.log('\n• over rate cap in same window → expect EOverRateCap');
  await expectAbort(isub.chargeMetered(keeper, { accountId, mandateId, amount: A2, seq: 1n }), 8, 'over-cap charge');

  // N-1 ★ the double-charge hole is closed
  console.log('\n• retry same bill (replay seq 0) → expect EBadChargeSeq');
  await expectAbort(isub.chargeMetered(keeper, { accountId, mandateId, amount: A1, seq: 0n }), 20, 'replayed bill');
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - A1, 'no double debit');
  console.log('\n• future seq (5) → expect EBadChargeSeq');
  await expectAbort(isub.chargeMetered(keeper, { accountId, mandateId, amount: A1, seq: 5n }), 20, 'future seq');
  console.log('\n• legacy charge() on PAYG mandate → expect EBadMode');
  await expectAbort(isub.charge(keeper, { accountId, mandateId, amount: A1 }), 12, 'seq-less metered charge');

  console.log(`\n• wait one window (${WINDOW_MS}ms), charge #2 (keeper, seq 1)`);
  await sleep(Number(WINDOW_MS) + (LOCAL ? 1_000 : 3_000));
  await isub.chargeMetered(keeper, { accountId, mandateId, amount: A2, seq: 1n });
  m = await isub.getMandate(mandateId);
  eqBig(m.spentTotal, A1 + A2, 'spent_total = 0.11 after window rollover');
  eqBig((await suiBalance(client, merchant.address)) - merchBefore, A1 + A2, 'merchant received both charges');

  // N-2 ★ refund
  console.log('\n• merchant refunds 0.05 back into the Account');
  const balBefore = (await isub.getAccount(accountId)).balance;
  await isub.refund(merchant, { accountId, mandateId, amount: REFUND });
  m = await isub.getMandate(mandateId);
  eqBig((await isub.getAccount(accountId)).balance, balBefore + REFUND, 'account credited by refund');
  eqBig(m.refundedTotal, REFUND, 'refunded_total = 0.05');
  eqBig(m.spentTotal, A1 + A2, 'spent_total untouched (gross budget is monotone)');
  console.log('\n• refund beyond spent (0.05+0.07 > 0.11) → expect ERefundExceedsSpent');
  await expectAbort(isub.refund(merchant, { accountId, mandateId, amount: (7n * SUI) / 100n }), 21, 'over-refund');
  console.log('\n• refund by non-merchant (keeper) → expect ENotMerchant');
  await expectAbort(isub.refund(keeper, { accountId, mandateId, amount: 1_000_000n }), 22, 'non-merchant refund');

  console.log(`\n✅ payg smoke passed — ${checks} assertions on ${NETWORK}`);
  console.log(`• explorer  mandate ${ex.object(mandateId)}`);
}

main().catch((e) => {
  console.error('\n❌ payg smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

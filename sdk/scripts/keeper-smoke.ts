// Deterministic keeper validation over gRPC. Sets up one Fixed subscription, hands
// the keeper that mandate id to WATCH, then ticks FASTER than the billing interval
// and asserts it:
//   1. auto-charges the due mandate (no manual charge calls),
//   2. stays idempotent — sub-interval ticks submit zero wasted/aborted txs,
//   3. spaces charges by the on-chain interval (end-to-end scheduling),
//   4. stops at the lifetime budget cap.
//
// Run: `npm run keeper:smoke`  (localnet)  or  `npm run keeper-smoke:testnet`.
import { IsubClient, IsubKeeper, keypairSigner } from '../src/index';
import { clientFor, actor, loadDeployment, fmt, sleep, explorer, NETWORK } from './env';

const LOCAL = NETWORK === 'localnet';
const SUI = 1_000_000_000n;
const DEPOSIT = (3n * SUI) / 10n; // 0.3 SUI
const PRICE = SUI / 20n; // 0.05 SUI/period
const BUDGET = (15n * SUI) / 100n; // 0.15 SUI → exactly 3 charges
const INTERVAL_MS = LOCAL ? 2_000n : 15_000n;
const TICK_MS = LOCAL ? 600 : 3_000; // < interval, to exercise the idempotency guard
const COLLECT_TIMEOUT = LOCAL ? 15_000 : 120_000;

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
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
  const keeperSigner = keypairSigner(keeperKp, client);

  console.log('• setting up a Fixed subscription…');
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  const { planId } = await isub.createPlanFixed(merchant, {
    price: PRICE,
    intervalMs: INTERVAL_MS,
    keeper: keeperSigner.address,
  });
  const expiryMs = BigInt(Date.now() + 60 * 60 * 1000);
  const { mandateId } = await isub.authorizeFixed(subscriber, {
    accountId, planId, expectedPrice: PRICE, expectedIntervalMs: INTERVAL_MS, expectedMerchant: merchant.address, totalBudget: BUDGET, expiryMs,
  });
  console.log(`  mandate ${mandateId}`);

  // The merchant backend would register the mandate id here; the keeper watches it.
  const keeper = new IsubKeeper(isub, keeperSigner, [mandateId]);
  const chargeTimes: number[] = [];
  let myFailed = 0;
  let budgetExhaustedSeen = false;

  console.log(`\n• running keeper (tick ${TICK_MS}ms < interval ${INTERVAL_MS}ms)…`);
  // Phase 1: collect the 3 budget-allowed charges (or time out).
  const t0 = Date.now();
  while (chargeTimes.length < 3 && Date.now() - t0 < COLLECT_TIMEOUT) {
    const r = await keeper.tick();
    for (const c of r.charged) if (c.mandateId === mandateId) {
      chargeTimes.push(Date.now());
      console.log(`  • charge #${chargeTimes.length} — ${fmt(c.amount)}`);
    }
    for (const f of r.failed) if (f.mandateId === mandateId) myFailed++;
    await sleep(TICK_MS);
  }
  // Phase 2: wait one full interval so the mandate is DUE again, then tick — now it
  // must refuse on budget (spent_total == total_budget). Without the wait it would
  // only ever report "not due yet" and never reach the budget gate.
  await sleep(Number(INTERVAL_MS) + (LOCAL ? 500 : 3_000));
  for (let i = 0; i < 4; i++) {
    const r = await keeper.tick();
    if (r.skipped.some((s) => s.mandateId === mandateId && s.reason === 'budget exhausted')) budgetExhaustedSeen = true;
    for (const f of r.failed) if (f.mandateId === mandateId) myFailed++;
    await sleep(TICK_MS);
  }

  const m = await isub.getMandate(mandateId);
  const account = await isub.getAccount(accountId);
  const span = chargeTimes.length === 3 ? chargeTimes[2]! - chargeTimes[0]! : 0;

  console.log('\n• assertions');
  check(chargeTimes.length === 3, `keeper auto-charged exactly 3× (got ${chargeTimes.length})`);
  check(myFailed === 0, `zero wasted/aborted charge txs — idempotency guard held (got ${myFailed})`);
  check(span >= Number(INTERVAL_MS) * 2 * 0.8, `charges spaced by interval — span ${span}ms ≥ ~${Number(INTERVAL_MS) * 2}ms`);
  check(m.spentTotal === 3n * PRICE, `spent_total = 3×price (${fmt(m.spentTotal)})`);
  check(m.spentTotal <= m.totalBudget, `never exceeded budget (${fmt(m.spentTotal)} ≤ ${fmt(m.totalBudget)})`);
  check(budgetExhaustedSeen, 'keeper stopped at budget cap (saw "budget exhausted" skip)');
  check(account.balance === DEPOSIT - 3n * PRICE, `account debited exactly 3×price (${fmt(account.balance)} left)`);

  console.log(`\n✅ keeper smoke passed — ${checks} assertions on ${NETWORK}`);
  console.log(`• explorer  mandate ${ex.object(mandateId)}`);
}

main().catch((e) => {
  console.error('\n❌ keeper smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

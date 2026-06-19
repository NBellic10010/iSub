// Scheduler (Architecture A) end-to-end on a REAL network (localnet or testnet).
// Simulates a subscription plan being adjusted over its lifetime — the thing Stripe
// Subscription Schedules do — while keeping the non-custodial iron law: the merchant
// pulls LESS silently, but NEVER more without a new signature.
//
//   One arc, real on-chain txs:
//     authorize(standard) -> charge#1 (standard, full)
//     -> DOWNGRADE to loyalty: wait 1 interval, charge#2 (standard), scheduler.tick()
//        issues a REAL refund of the delta -> period nets the loyalty price (no new sig)
//     -> UPGRADE to pro: scheduler.tick() -> awaiting_consent (mandate price UNCHANGED
//        on-chain — no over-pull); subscriber signs a NEW mandate at the pro price +
//        revokes the old; applyConsent() repoints -> charge#3 (pro, full)
//
//   Phase boundaries are driven by the nowMs passed to scheduler.tick() (logical time);
//   only the on-chain interval gate between charge#1 and #2 needs a real wait.
//
// Run: `npm run scheduler-e2e:testnet`  (or `npm run scheduler-e2e` on localnet).
import { IsubClient, IsubScheduler, memoryScheduleStore, keypairSigner, MandateStatus, abortCodeOf, errorName } from '../src/index';
import type { SchedulePhase, SchedulerEvent } from '../src/index';
import { clientFor, actor, suiBalance, loadDeployment, fmt, sleep, explorer, NETWORK } from './env';

const LOCAL = NETWORK === 'localnet';
const SUI = 1_000_000_000n;
const P_STD = SUI / 100n;            // 0.010 SUI — standard
const P_LOW = (6n * SUI) / 1000n;    // 0.006 SUI — loyalty (downgrade, pull less)
const P_HIGH = SUI / 50n;            // 0.020 SUI — pro (upgrade, pull more → needs new sig)
const DELTA = P_STD - P_LOW;         // 0.004 SUI refunded each loyalty period
const DEPOSIT = (6n * SUI) / 100n;   // 0.060 SUI into the Account
const BUDGET = SUI / 5n;             // 0.200 SUI per-mandate lifetime cap
const INTERVAL_MS = LOCAL ? 2_000n : 8_000n;
const WAIT = Number(INTERVAL_MS) + (LOCAL ? 1_000 : 4_000);

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}
const eqBig = (a: bigint, b: bigint, label: string): void => check(a === b, `${label} — ${fmt(a)} == ${fmt(b)}`);

async function expectAbort(p: Promise<unknown>, code: number, label: string): Promise<void> {
  try { await p; } catch (e) {
    const got = abortCodeOf(e);
    check(got === code, `${label} → aborts ${errorName(code)} (#${code})${got === code ? '' : ` [got #${got}]`}`);
    return;
  }
  throw new Error(`✗ ${label}: expected abort #${code} but the tx succeeded`);
}

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId }); // coinType defaults to SUI
  const ex = explorer();
  console.log(`• network: ${NETWORK} ｜ package ${packageId}`);

  console.log('• funding actors (subscriber / merchant / keeper)…');
  const [subKp, merchantKp, keeperKp] = await Promise.all([actor(client, 'subscriber'), actor(client, 'merchant'), actor(client, 'keeper')]);
  const subscriber = keypairSigner(subKp, client);
  const merchant = keypairSigner(merchantKp, client);
  const keeper = keypairSigner(keeperKp, client);
  console.log(`  subscriber ${subscriber.address}`);
  console.log(`  merchant   ${merchant.address}`);

  // The scheduler is a MERCHANT-side service — its signer is the merchant (refund is
  // merchant-only). It only acts at phase boundaries; the keeper still does periodic charging.
  const events: SchedulerEvent[] = [];
  const scheduler = new IsubScheduler(isub, merchant, { store: memoryScheduleStore(), onEvent: (e) => events.push(e) });

  // ── setup: account + two plans (standard, pro) + a standard mandate ──────────────
  console.log('\n• open_account + deposit');
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT, 'account funded');

  console.log('\n• create_plan_fixed ×2 (merchant): standard + pro');
  const { planId: stdPlan } = await isub.createPlanFixed(merchant, { price: P_STD, intervalMs: INTERVAL_MS, keeper: keeper.address });
  const { planId: proPlan } = await isub.createPlanFixed(merchant, { price: P_HIGH, intervalMs: INTERVAL_MS, keeper: keeper.address });

  console.log('\n• authorize standard mandate (subscriber signs once)');
  const expiryMs = BigInt(Date.now() + 60 * 60 * 1000);
  const { mandateId: m1 } = await isub.authorizeFixed(subscriber, {
    accountId, planId: stdPlan, expectedPrice: P_STD, expectedIntervalMs: INTERVAL_MS, expectedMerchant: merchant.address, totalBudget: BUDGET, expiryMs,
  });
  eqBig((await isub.getMandate(m1)).price, P_STD, 'mandate ceiling = standard price');

  // Register the phase plan. Logical phase times (0 / 1000 / 2000) drive scheduler.tick().
  const phases: SchedulePhase[] = [
    { startMs: 0, kind: 'fixed', price: P_STD, intervalMs: INTERVAL_MS, label: 'standard' },
    { startMs: 1000, kind: 'fixed', price: P_LOW, intervalMs: INTERVAL_MS, label: 'loyalty' },
    { startMs: 2000, kind: 'fixed', price: P_HIGH, intervalMs: INTERVAL_MS, label: 'pro' },
  ];
  await scheduler.schedule({ subscriptionId: 'sub-1', accountId, planId: stdPlan, merchant: merchant.address, mandateId: m1, phases, nowMs: 0 });
  check(scheduler.snapshot()[0]!.cursor === 0, 'schedule registered on the standard phase');

  // ── period 1: standard, charged in full ─────────────────────────────────────────
  console.log('\n• period 1 — charge #1 (standard, full)');
  await isub.charge(keeper, { accountId, mandateId: m1, amount: P_STD });
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - P_STD, 'account debited the standard price');

  // ── DOWNGRADE → loyalty: silent, no new signature ───────────────────────────────
  console.log('\n• DOWNGRADE → loyalty (advance the cursor; baseline the refund anchor)');
  await scheduler.tick(1000);
  check(scheduler.snapshot()[0]!.cursor === 1 && scheduler.snapshot()[0]!.status === 'active', 'advanced to loyalty phase (silent, no consent)');

  console.log(`\n• period 2 — wait one interval (${WAIT}ms), charge #2 (still pulls the standard ceiling)`);
  await sleep(WAIT);
  await isub.charge(keeper, { accountId, mandateId: m1, amount: P_STD });
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - 2n * P_STD, 'account debited the standard ceiling again (pre-refund)');

  console.log('• scheduler.tick() → REAL refund of the loyalty delta');
  const before = events.length;
  await scheduler.tick(1500);
  const refundEv = events.slice(before).find((e) => e.type === 'downgrade.refunded');
  check(!!refundEv && refundEv.type === 'downgrade.refunded' && refundEv.amount === DELTA, `refunded the ${fmt(DELTA)} delta on-chain`);
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - P_STD - P_LOW, 'period 2 NET = loyalty price (standard pulled, delta refunded — no new signature)');
  const m1state = await isub.getMandate(m1);
  eqBig(m1state.refundedTotal, DELTA, 'mandate refunded_total = the downgrade delta');
  eqBig(m1state.spentTotal, 2n * P_STD, 'mandate spent_total = 2×standard (budget burns gross — v1 known wrinkle)');

  // ── UPGRADE → pro: a consent event, never a silent over-pull ─────────────────────
  console.log('\n• UPGRADE → pro: scheduler.tick() must GATE on consent (cannot pull more)');
  const beforeUp = events.length;
  await scheduler.tick(2000);
  const consentEv = events.slice(beforeUp).find((e) => e.type === 'consent.required');
  check(!!consentEv && consentEv.type === 'consent.required' && consentEv.fromPrice === P_STD && consentEv.toPrice === P_HIGH, `consent.required emitted (${fmt(P_STD)} → ${fmt(P_HIGH)})`);
  check(scheduler.snapshot()[0]!.status === 'awaiting_consent' && scheduler.snapshot()[0]!.cursor === 1, 'frozen on loyalty phase, awaiting consent');
  eqBig((await isub.getMandate(m1)).price, P_STD, 'on-chain mandate ceiling UNCHANGED — no silent over-pull');

  console.log('\n• subscriber consents: authorize a NEW pro mandate + revoke the old (their PTB)');
  const { mandateId: m2 } = await isub.authorizeFixed(subscriber, {
    accountId, planId: proPlan, expectedPrice: P_HIGH, expectedIntervalMs: INTERVAL_MS, expectedMerchant: merchant.address, totalBudget: BUDGET, expiryMs,
  });
  await isub.revoke(subscriber, { mandateId: m1 });
  check((await isub.getMandate(m1)).status === MandateStatus.Revoked, 'old standard mandate revoked');
  await expectAbort(isub.charge(keeper, { accountId, mandateId: m1, amount: P_STD }), 4, 'charge on the revoked old mandate');

  await scheduler.applyConsent('sub-1', m2, 2100);
  const snap = scheduler.snapshot()[0]!;
  check(snap.status === 'active' && snap.mandateId === m2 && snap.cursor === 2, 'applyConsent → active, repointed to the pro mandate, advanced to pro');
  check(events.some((e) => e.type === 'mandate.replaced'), 'mandate.replaced emitted (merchant rewires the keeper)');

  // ── period 3: pro, charged in full on the new mandate ────────────────────────────
  console.log('\n• period 3 — charge #3 (pro, full, on the new mandate)');
  await isub.charge(keeper, { accountId, mandateId: m2, amount: P_HIGH });
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - P_STD - P_LOW - P_HIGH, 'period 3 NET = pro price (full)');
  eqBig((await isub.getMandate(m2)).spentTotal, P_HIGH, 'pro mandate spent_total = pro price');
  await scheduler.tick(2200);
  eqBig((await isub.getMandate(m2)).refundedTotal, 0n, 'no refund on the matching pro phase (effective == ceiling)');

  // ── the economic summary: three periods, three prices, one signature per increase ──
  const spent = DEPOSIT - (await isub.getAccount(accountId)).balance;
  eqBig(spent, P_STD + P_LOW + P_HIGH, 'TOTAL paid = standard + loyalty + pro (each adjustment honored)');

  // ── cleanup: revoke + non-custodial exit ─────────────────────────────────────────
  console.log('\n• cleanup: revoke pro mandate + withdraw_all (non-custodial exit)');
  await isub.revoke(subscriber, { mandateId: m2 });
  await isub.withdrawAll(subscriber, { accountId });
  eqBig((await isub.getAccount(accountId)).balance, 0n, 'account drained to 0 (subscriber recovered the remainder)');

  console.log(`\n✅ scheduler e2e passed — ${checks} assertions, full plan-adjustment arc on ${NETWORK}`);
  console.log('• explorer');
  console.log(`  account       ${ex.object(accountId)}`);
  console.log(`  std mandate   ${ex.object(m1)}`);
  console.log(`  pro mandate   ${ex.object(m2)}`);
}

main().catch((e) => {
  console.error('\n❌ scheduler e2e failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

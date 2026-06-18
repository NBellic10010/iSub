// End-to-end smoke over gRPC: drives the whole iSub lifecycle through the SDK
// against a real network (localnet or testnet), asserting chain state + aborts.
//
//   open_account -> deposit -> create_plan -> authorize -> charge ×2
//   -> [negative] interval gate, post-revoke gate -> revoke -> withdraw_all
//
// Run: `npm run smoke`  (localnet)  or  `npm run smoke:testnet`.
import { IsubClient, keypairSigner, MandateStatus, ChargeMode, errorName, abortCodeOf } from '../src/index';
import { clientFor, actor, suiBalance, loadDeployment, fmt, sleep, explorer, NETWORK } from './env';

const LOCAL = NETWORK === 'localnet';
const SUI = 1_000_000_000n; // MIST per SUI
const DEPOSIT = (3n * SUI) / 10n; // 0.3 SUI into the Account
const PRICE = SUI / 20n; // 0.05 SUI per period
const BUDGET = SUI / 5n; // 0.2 SUI lifetime cap on the mandate
// Interval must exceed tx round-trip jitter so the pre-interval negative test is
// deterministic — tiny on localnet, larger on a public network.
const INTERVAL_MS = LOCAL ? 2_000n : 15_000n;
const POST_INTERVAL_WAIT = Number(INTERVAL_MS) + (LOCAL ? 1_500 : 5_000);

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}
function eqBig(a: bigint, b: bigint, label: string): void {
  check(a === b, `${label} — ${fmt(a)} == ${fmt(b)}`);
}

async function expectGone(read: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await read();
  } catch {
    check(true, label);
    return;
  }
  throw new Error(`✗ ${label}: object still readable (expected deletion)`);
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
  const isub = new IsubClient({ client, packageId }); // coinType defaults to SUI
  const ex = explorer();
  console.log(`• network: ${NETWORK} ｜ package ${packageId}`);

  console.log('• funding actors (subscriber / merchant / keeper)…');
  const [subKp, merchantKp, keeperKp] = await Promise.all([
    actor(client, 'subscriber'),
    actor(client, 'merchant'),
    actor(client, 'keeper'),
  ]);
  const subscriber = keypairSigner(subKp, client);
  const merchant = keypairSigner(merchantKp, client);
  const keeper = keypairSigner(keeperKp, client);
  console.log(`  subscriber ${subscriber.address}`);
  console.log(`  merchant   ${merchant.address}`);
  console.log(`  keeper     ${keeper.address}`);

  // 1) open + deposit
  console.log('\n• open_account + deposit');
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT, 'account funded');

  // 2) merchant plan (Fixed)
  console.log('\n• create_plan_fixed (merchant)');
  const { planId } = await isub.createPlanFixed(merchant, {
    price: PRICE,
    intervalMs: INTERVAL_MS,
    keeper: keeper.address,
  });
  const plan = await isub.getPlan(planId);
  check(plan.mode === ChargeMode.Fixed && plan.active, 'plan is Fixed + active');

  // 3) authorize — signs once, moves NO funds (invariant #10)
  console.log('\n• authorize (subscriber signs once)');
  const expiryMs = BigInt(Date.now() + 60 * 60 * 1000); // +1h
  const { mandateId } = await isub.authorizeFixed(subscriber, {
    accountId, planId, expectedPrice: PRICE, expectedIntervalMs: INTERVAL_MS, expectedMerchant: merchant.address, totalBudget: BUDGET, expiryMs,
  });
  let m = await isub.getMandate(mandateId);
  check(m.status === MandateStatus.Active, 'mandate Active');
  eqBig(m.spentTotal, 0n, 'mandate spent_total = 0');
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT, 'authorize moved no funds');

  // 4) charge #1 — due immediately (Stripe-style), permissionless keeper triggers it
  console.log('\n• charge #1 (keeper, immediately due)');
  const merchBefore1 = await suiBalance(client, merchant.address);
  await isub.charge(keeper, { accountId, mandateId, amount: PRICE });
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - PRICE, 'account debited by price');
  eqBig((await suiBalance(client, merchant.address)) - merchBefore1, PRICE, 'merchant received price');
  eqBig((await isub.getMandate(mandateId)).spentTotal, PRICE, 'spent_total = price');

  // 5) [negative] charge again immediately → interval gate (F-01 / invariant #3)
  console.log('\n• charge #2 immediately → expect EIntervalNotElapsed');
  await expectAbort(isub.charge(keeper, { accountId, mandateId, amount: PRICE }), 6, 'pre-interval charge');
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - PRICE, 'account unchanged after blocked charge');

  // 6) wait one interval, charge #2 → ok
  console.log(`\n• wait one interval (${POST_INTERVAL_WAIT}ms), charge #2 (keeper)`);
  await sleep(POST_INTERVAL_WAIT);
  const merchBefore2 = await suiBalance(client, merchant.address);
  await isub.charge(keeper, { accountId, mandateId, amount: PRICE });
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - 2n * PRICE, 'account debited twice');
  eqBig((await suiBalance(client, merchant.address)) - merchBefore2, PRICE, 'merchant received 2nd price');
  eqBig((await isub.getMandate(mandateId)).spentTotal, 2n * PRICE, 'spent_total = 2×price');

  // 7) revoke — cancel anytime, terminal (invariant #6)
  console.log('\n• revoke (subscriber)');
  await isub.revoke(subscriber, { mandateId });
  m = await isub.getMandate(mandateId);
  check(m.status === MandateStatus.Revoked, 'mandate Revoked');

  // 8) [negative] charge after revoke → status gate
  console.log('\n• charge after revoke → expect ENotActive');
  await expectAbort(isub.charge(keeper, { accountId, mandateId, amount: PRICE }), 4, 'post-revoke charge');

  // 9) withdraw_all — non-custodial exit (invariant #7)
  console.log('\n• withdraw_all (subscriber)');
  const subBefore = await suiBalance(client, subscriber.address);
  const remaining = DEPOSIT - 2n * PRICE;
  await isub.withdrawAll(subscriber, { accountId });
  eqBig((await isub.getAccount(accountId)).balance, 0n, 'account drained to 0');
  check(
    (await suiBalance(client, subscriber.address)) > subBefore,
    `subscriber recovered funds (~${fmt(remaining)}, minus gas)`,
  );

  // 10) close — reclaim storage rebate on the finished objects
  console.log('\n• close_mandate + close_account (reclaim storage)');
  await isub.closeMandate(subscriber, { mandateId });
  await isub.closeAccount(subscriber, { accountId });
  await expectGone(() => isub.getMandate(mandateId), 'mandate object deleted');
  await expectGone(() => isub.getAccount(accountId), 'account object deleted');

  console.log(`\n✅ smoke passed — ${checks} assertions, full lifecycle on ${NETWORK}`);
  console.log('• explorer');
  console.log(`  account  ${ex.object(accountId)}`);
  console.log(`  mandate  ${ex.object(mandateId)}`);
  console.log(`  merchant ${ex.account(merchant.address)}`);
}

main().catch((e) => {
  console.error('\n❌ smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

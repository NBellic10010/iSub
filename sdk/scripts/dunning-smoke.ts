// Billing state machine smoke (P-1..P-5 + reconciliation) on a real network.
//
//   underfunded account -> charge #1 -> due+dry -> PAST_DUE (event) -> top-up ->
//   auto-recovery charge (zero signatures) -> dry again -> grace expires -> LAPSED
//   (keeper stops billing) -> restart keeper from the same store (watch set survives)
//   -> external permissionless charge detected as drift (charge.observed) ->
//   reconcile() = zero drift.
//
// Run: `npm run dunning:smoke` (localnet) or `npm run dunning-smoke:testnet`.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsubClient, IsubKeeper, keypairSigner, reconcile, type KeeperEvent } from '../src/index';
import { fileStore } from '../src/store-file';
import { clientFor, actor, loadDeployment, fmt, sleep, NETWORK } from './env';

const LOCAL = NETWORK === 'localnet';
const SUI = 1_000_000_000n;
const PRICE = SUI / 20n; // 0.05 SUI per period
const INTERVAL_MS = LOCAL ? 2_000n : 15_000n;
const GRACE_MS = LOCAL ? 5_000 : 20_000;
const BUDGET = (15n * SUI) / 100n; // 3 charges max
const STORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs', `dunning-store-${NETWORK}`);

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}
const waitInterval = async (extra = 0): Promise<void> => {
  await sleep(Number(INTERVAL_MS) + (LOCAL ? 600 : 3_000) + extra);
};
const TICK_GAP = LOCAL ? 500 : 2_000;
const PHASE_TIMEOUT = LOCAL ? 10_000 : 60_000;

/** Tick repeatedly until `done(result)` is true (testnet tolerance for transient RPC blips). */
async function tickUntil(
  keeper: IsubKeeper,
  done: (r: Awaited<ReturnType<IsubKeeper['tick']>>) => boolean,
  label: string,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const r = await keeper.tick();
    for (const f of r.failed) console.log(`    (fail: ${f.deterministic ? `abort #${f.abortCode}` : 'transient'} — ${f.error.slice(0, 120)})`);
    if (done(r)) return;
    if (Date.now() - t0 > PHASE_TIMEOUT) {
      const reasons = r.skipped.map((s) => s.reason).join('; ') || '(none)';
      throw new Error(`✗ ${label}: timed out after ${PHASE_TIMEOUT}ms — last skips: ${reasons}`);
    }
    await sleep(TICK_GAP);
  }
}

async function main(): Promise<void> {
  rmSync(STORE_DIR, { recursive: true, force: true }); // fresh run
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
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

  console.log('• setup: account funded for exactly ONE period…');
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: PRICE }); // 1×price only
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

  const events: KeeperEvent[] = [];
  const store = fileStore(STORE_DIR);
  const keeper = new IsubKeeper(isub, keeperSigner, [mandateId], {
    store,
    dunning: { graceMs: GRACE_MS },
    dueMarginMs: 0, // exact-tick assertions below; production keeps the default margin
    onEvent: (e) => {
      events.push(e);
      console.log(`  ⚡ ${e.type} ${e.mandateId.slice(0, 8)}…`);
    },
  });
  const has = (type: KeeperEvent['type']): boolean => events.some((e) => e.type === type && e.mandateId === mandateId);

  console.log('\n• tick until the immediately-due charge #1 lands');
  await tickUntil(keeper, (r) => r.charged.length > 0, 'charge #1');
  check(has('charge.succeeded'), 'charge #1 landed (event charge.succeeded)');

  console.log('\n• account is now dry; wait one interval → due + dry = PAST_DUE');
  await waitInterval();
  await tickUntil(keeper, () => keeper.snapshot()[mandateId]?.state === 'past_due', 'past_due transition');
  check(has('mandate.past_due'), 'event mandate.past_due fired (P-1: limbo is now observable)');
  check(keeper.snapshot()[mandateId]?.state === 'past_due', 'lifecycle = past_due');

  console.log('\n• user tops up → keeper recovers WITHOUT any signature');
  await isub.deposit(subscriber, { accountId, amount: PRICE });
  await tickUntil(keeper, (r) => r.charged.length > 0, 'recovery charge');
  check(has('mandate.recovered'), 'recovery charge landed automatically (event mandate.recovered)');
  check(keeper.snapshot()[mandateId]?.state === 'active', 'lifecycle back to active');

  console.log(`\n• dry again; let the grace window (${GRACE_MS}ms) run out → LAPSED`);
  await waitInterval();
  await tickUntil(keeper, () => keeper.snapshot()[mandateId]?.state === 'past_due', 'past_due again');
  check(keeper.snapshot()[mandateId]?.state === 'past_due', 'past_due again');
  await sleep(GRACE_MS + 500);
  await tickUntil(keeper, () => keeper.snapshot()[mandateId]?.state === 'lapsed', 'lapse');
  check(has('mandate.lapsed'), 'event mandate.lapsed fired');
  check(!keeper.watching().includes(mandateId), 'keeper stopped billing the lapsed mandate');
  await keeper.close();

  console.log('\n• restart: a NEW keeper from the same store (P-2 persistence, P-3 journal)');
  const keeper2 = new IsubKeeper(isub, keeperSigner, [], { store, dunning: { graceMs: GRACE_MS }, dueMarginMs: 0 });
  await keeper2.init();
  check(keeper2.snapshot()[mandateId]?.state === 'lapsed', 'watch set + lifecycle survived restart');
  check((await store.readJournal()).length > 0, 'append-only journal has the action history');

  console.log('\n• external charge detection: a third party triggers the permissionless Fixed charge');
  const { accountId: acct2 } = await isub.openAccount(subscriber);
  const { mandateId: m2 } = await isub.authorizeFixed(subscriber, {
    accountId: acct2,
    planId,
    expectedPrice: PRICE,
    expectedIntervalMs: INTERVAL_MS,
    expectedMerchant: merchant.address,
    totalBudget: BUDGET,
    expiryMs,
  });
  keeper2.watch(m2);
  await keeper2.tick(); // baselines m2 at seq 0 (account empty → no charge)
  await isub.deposit(subscriber, { accountId: acct2, amount: PRICE });
  // the SUBSCRIBER (not the keeper) triggers the due charge — permissionless by design
  await isub.charge(subscriber, { accountId: acct2, mandateId: m2, amount: PRICE });
  let observed = false;
  await tickUntil(
    keeper2,
    (r) => {
      observed ||= r.events.some((e) => e.type === 'charge.observed' && e.mandateId === m2);
      return observed;
    },
    'external charge observation',
  );
  check(observed, 'drift detected: charge.observed for the externally-triggered charge');
  await keeper2.close();

  console.log('\n• reconcile journal vs chain (Phase C)');
  const report = await reconcile(isub, store);
  for (const row of report.rows) {
    console.log(
      `  ${row.mandateId.slice(0, 10)}… chain=${row.chainCount} journaled=${row.journaledCount} observed=${row.observedCount} drift=${row.countDrift} unattributed=${fmt(row.unattributedAmount)}`,
    );
  }
  check(report.ok, 'zero count drift — every on-chain charge is accounted for');

  console.log(`\n✅ dunning smoke passed — ${checks} assertions on ${NETWORK}`);
}

main().catch((e) => {
  console.error('\n❌ dunning smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

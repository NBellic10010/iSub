// PAYG biller smoke — fully headless. A FaithfulChain enforces the SAME rules as the
// Move contract (seq idempotency, rate_cap, total_budget, max_per_charge, balance), so
// the biller's clamp / carry / seq-serialization / idempotency are verified with no chain.
//
// Run: `npm run biller:smoke` (sets --experimental-sqlite for the SQL-parity section).
import { IsubBiller, memBillerStore, spendableNow, type BillerChain, type BillerEvent } from '../src/biller';
import { ChargeMode, MandateStatus } from '../src/constants';
import { IsubAbortError } from '../src/errors';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';
import { openDb } from '../src/db';
import { sqlBillerStore } from '../src/sql-store';

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}

const SIG: IsubSigner = { address: '0xkeeper', signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };

function mkMandate(over: Partial<MandateState> = {}): MandateState {
  return {
    id: '0xm', accountId: '0xacc', subscriber: '0xsub', merchant: '0xmer', planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
    rateCap: 60n, rateWindowMs: 1000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: '0xkeeper',
    spentTotal: 0n, totalBudget: 200n, expiryMs: 10_000_000n, chargeSeq: 0n, refundedTotal: 0n,
    maxPerCharge: 60n, notBeforeMs: 0n, status: MandateStatus.Active, ...over,
  };
}

/** Mutable on-chain simulation that aborts exactly like `subscription::charge_metered`. */
class FaithfulChain implements BillerChain {
  now = 0;
  transientLeft = 0; // throw BEFORE applying → the charge did NOT land
  lostAckLeft = 0; // apply THEN throw → committed-but-lost-ack (the real double-charge trap)
  constructor(public m: MandateState, public balance: bigint) {}
  async getMandate(): Promise<MandateState> {
    return { ...this.m };
  }
  async getAccount(): Promise<AccountState> {
    return { id: this.m.accountId, owner: '0xowner', balance: this.balance };
  }
  async chargeMetered(_s: IsubSigner, p: { accountId: string; mandateId: string; amount: bigint; seq: bigint }): Promise<{ digest: string }> {
    if (this.transientLeft > 0) {
      this.transientLeft--;
      throw new Error('RPC timeout'); // transient: not an abort, didn't land
    }
    if (p.seq !== this.m.chargeSeq) throw new IsubAbortError(20);
    if (this.m.status !== MandateStatus.Active) throw new IsubAbortError(4);
    const now = BigInt(this.now);
    if (now >= this.m.expiryMs) throw new IsubAbortError(5);
    if (now >= this.m.windowStartMs + this.m.rateWindowMs) {
      this.m.windowStartMs = now;
      this.m.windowSpent = 0n;
    }
    if (this.m.windowSpent + p.amount > this.m.rateCap) throw new IsubAbortError(8);
    if (p.amount > this.m.maxPerCharge) throw new IsubAbortError(24);
    if (this.m.spentTotal + p.amount > this.m.totalBudget) throw new IsubAbortError(9);
    if (this.balance < p.amount) throw new IsubAbortError(10);
    this.m.windowSpent += p.amount;
    this.m.spentTotal += p.amount;
    this.m.chargeSeq += 1n;
    this.balance -= p.amount;
    if (this.lostAckLeft > 0) {
      this.lostAckLeft--;
      throw new Error('RPC timeout (committed but lost ack)'); // tx landed; client never saw the response
    }
    return { digest: `dig${this.m.chargeSeq}` };
  }
}

async function main(): Promise<void> {
  // ===== Scenario A: caps, carry, budget exhaustion, idempotency =====
  // budget 200, rateCap 60/window, maxPerCharge 60. Record 10×25 = 250 (> budget).
  console.log('• scenario A: caps + carry + budget exhaustion');
  const chain = new FaithfulChain(mkMandate(), 10_000n);
  const store = memBillerStore();
  const events: BillerEvent[] = [];
  const biller = new IsubBiller(chain, SIG, store, { onEvent: (e) => events.push(e) });

  for (let i = 0; i < 10; i++) await biller.recordUsage({ mandateId: '0xm', amount: 25n, usageId: `u${i}`, atMs: i });
  const before = (await store.unbilled('0xm')).length;
  await biller.recordUsage({ mandateId: '0xm', amount: 25n, usageId: 'u0', atMs: 0 }); // duplicate
  check((await store.unbilled('0xm')).length === before, 'duplicate usageId is ignored (idempotent ingest)');

  let totalCharged = 0n;
  let perFlushOk = true;
  for (let t = 0; t <= 6000; t += 1000) {
    chain.now = t;
    const [r] = await biller.flush('0xm', t);
    totalCharged += r!.charged;
    if (r!.charged > 60n) perFlushOk = false; // never exceeds rate_cap in a window
  }
  const m = await chain.getMandate();
  check(perFlushOk, 'no single charge ever exceeds rate_cap (60)');
  check(totalCharged === 200n, `charged exactly the budget (200) — got ${totalCharged}`);
  check(m.spentTotal === 200n, 'on-chain spent_total == budget');
  check(m.chargeSeq === 4n, `charge_seq advanced once per charge (4) — got ${m.chargeSeq}`);
  check(events.some((e) => e.type === 'budget.exhausted'), 'budget.exhausted event emitted');
  check(events.some((e) => e.type === 'usage.carried'), 'over-budget usage carried (not dropped silently)');
  check(events.filter((e) => e.type === 'charge.failed').length === 0, 'zero charge failures (clamps avoided every abort)');

  chain.now = 7000;
  const again = await biller.flush('0xm', 7000);
  check(again.every((r) => r.charged === 0n), 'no double-charge after fully billed/exhausted');

  // ===== Scenario B: per-mandate single-flight (concurrency) =====
  console.log('\n• scenario B: concurrent flush is serialized (no seq collision)');
  const chainB = new FaithfulChain(mkMandate({ id: '0xb', totalBudget: 1000n, rateCap: 1000n, maxPerCharge: 1000n }), 10_000n);
  const billerB = new IsubBiller(chainB, SIG, memBillerStore(), {});
  for (let i = 0; i < 5; i++) await billerB.recordUsage({ mandateId: '0xb', amount: 30n, usageId: `c${i}` });
  chainB.now = 0;
  const concurrent = (await Promise.all([billerB.flush('0xb', 0), billerB.flush('0xb', 0)])).flat();
  const chargedB = concurrent.reduce((s, r) => s + r.charged, 0n);
  const mB = await chainB.getMandate();
  check(chargedB === 150n && mB.spentTotal === 150n, `concurrent flush bills each record exactly once (150) — got ${chargedB}`);
  check(mB.chargeSeq === 1n, 'single-flight collapsed concurrent flushes into one charge (seq=1)');

  // ===== Scenario C: transient handling (retry in-flight; classify if stuck) =====
  console.log('\n• scenario C: transient retried in-flight; stuck transient classified');
  const storeC = memBillerStore();
  const chainC = new FaithfulChain(mkMandate({ id: '0xc' }), 1000n);
  const billerC = new IsubBiller(chainC, SIG, storeC, {});
  await billerC.recordUsage({ mandateId: '0xc', amount: 30n, usageId: 'x0' });
  chainC.now = 0;
  chainC.transientLeft = 1; // one transient that did NOT land, then success
  const c = await billerC.flush('0xc', 0);
  const mC = await chainC.getMandate();
  check(c[0]!.charged === 30n && mC.spentTotal === 30n && mC.chargeSeq === 1n, 'transient-not-landed retried in-flight → charged exactly once');
  check((await storeC.unbilled('0xc')).length === 0, 'record billed after in-flight retry');

  const storeC2 = memBillerStore();
  const chainC2 = new FaithfulChain(mkMandate({ id: '0xc2' }), 1000n);
  const evC2: BillerEvent[] = [];
  const billerC2 = new IsubBiller(chainC2, SIG, storeC2, { onEvent: (e) => evC2.push(e) });
  await billerC2.recordUsage({ mandateId: '0xc2', amount: 30n, usageId: 'y0' });
  chainC2.now = 0;
  chainC2.transientLeft = 99; // RPC down beyond maxRetries
  const c2 = await billerC2.flush('0xc2', 0);
  check(c2[0]!.charged === 0n, 'stuck transient → nothing charged');
  check(evC2.some((e) => e.type === 'charge.failed' && !e.deterministic), 'stuck transient classified non-deterministic charge.failed');
  check((await storeC2.unbilled('0xc2')).length === 1, 'record kept unbilled for a later flush');

  // ===== Scenario D: spendableNow = min(budget, window, perCharge, balance) =====
  console.log('\n• scenario D: spendableNow clamp');
  check(spendableNow(mkMandate({ rateCap: 50n, totalBudget: 200n, maxPerCharge: 30n }), 1000n, 0) === 30n, 'spendable = min(...) = maxPerCharge (30)');
  check(spendableNow(mkMandate({ status: MandateStatus.Revoked }), 1000n, 0) === 0n, 'revoked → spendable 0');
  check(spendableNow(mkMandate({ notBeforeMs: 5000n }), 1000n, 0) === 0n, 'before first-charge window → spendable 0');

  // ===== Scenario E: SQL-backed BillerStore parity =====
  console.log('\n• scenario E: sqlBillerStore parity');
  const db = openDb(':memory:');
  const sqlS = sqlBillerStore(db, 'm-sql');
  const chainE = new FaithfulChain(mkMandate({ id: '0xe', totalBudget: 1000n, rateCap: 1000n, maxPerCharge: 1000n }), 10_000n);
  const billerE = new IsubBiller(chainE, SIG, sqlS, {});
  const ins1 = await sqlS.recordUsage({ usageId: 's1', mandateId: '0xe', amount: 40n, atMs: 1 });
  const ins2 = await sqlS.recordUsage({ usageId: 's1', mandateId: '0xe', amount: 40n, atMs: 1 });
  check(ins1 && !ins2, 'sqlBillerStore dedups by usageId (INSERT … ON CONFLICT DO NOTHING)');
  chainE.now = 0;
  const e1 = await billerE.flush('0xe', 0);
  check(e1[0]!.charged === 40n, 'biller charges via sqlBillerStore');
  check((await sqlS.unbilled('0xe')).length === 0, 'billed records cleared in SQL (markBilled)');

  // ===== Scenario F: lost-ack double-charge is prevented (in-flight recovery) =====
  // The charge lands on-chain but the client gets a network error → records stay unbilled.
  // The settle loop must RECONCILE (seq advanced) and mark billed, NOT charge again.
  console.log('\n• scenario F: lost-ack → in-flight recovery, no double-charge');
  const chainF = new FaithfulChain(mkMandate({ id: '0xf', totalBudget: 1000n, rateCap: 1000n, maxPerCharge: 1000n }), 10_000n);
  const evF: BillerEvent[] = [];
  const billerF = new IsubBiller(chainF, SIG, memBillerStore(), { onEvent: (e) => evF.push(e) });
  await billerF.recordUsage({ mandateId: '0xf', amount: 50n, usageId: 'f1' });
  chainF.now = 0;
  chainF.lostAckLeft = 1;
  const f = await billerF.flush('0xf', 0);
  const mF = await chainF.getMandate();
  check(mF.spentTotal === 50n && mF.chargeSeq === 1n, 'lost-ack: charge landed exactly once on-chain (spent=50, seq=1)');
  check(f[0]!.charged === 50n, 'settle recovered the landed charge in-flight (reported once)');
  check(evF.some((e) => e.type === 'charge.succeeded' && e.digest === 'recovered'), 'recovery emitted charge.succeeded(recovered)');

  // ===== Scenario G: crash mid-settle → restart recovers (no double-charge) =====
  console.log('\n• scenario G: crash before recovery → restart reconciles');
  const chainG = new FaithfulChain(mkMandate({ id: '0xg', totalBudget: 1000n, rateCap: 1000n, maxPerCharge: 1000n }), 10_000n);
  const storeG = memBillerStore();
  const crashed = new IsubBiller(chainG, SIG, storeG, { policy: { maxRetries: 1 } }); // 1 attempt → no in-flight recovery
  await crashed.recordUsage({ mandateId: '0xg', amount: 50n, usageId: 'g1' });
  chainG.now = 0;
  chainG.lostAckLeft = 1;
  const g1 = await crashed.flush('0xg', 0);
  const mG1 = await chainG.getMandate();
  check(g1[0]!.charged === 0n && (await storeG.unbilled('0xg')).length === 1, 'crash left an orphan: charge landed but record still unbilled');
  check(mG1.chargeSeq === 1n && mG1.spentTotal === 50n, 'the orphaned charge is on-chain (seq=1, spent=50)');
  const restarted = new IsubBiller(chainG, SIG, storeG, {}); // fresh instance over the same store
  const g2 = await restarted.flush('0xg', 0);
  const mG2 = await chainG.getMandate();
  check(mG2.spentTotal === 50n && mG2.chargeSeq === 1n, 'restart recovery: NO double-charge (spent still 50)');
  check(g2[0]!.charged === 50n && (await storeG.unbilled('0xg')).length === 0, 'restart reconciled the orphan + marked billed');

  // ===== Scenario H: cross-instance lock (two billers can't bill the same tenant) =====
  console.log('\n• scenario H: cross-instance single-flight lock (SQL)');
  const dbL = openDb(':memory:');
  const chainL = new FaithfulChain(mkMandate({ id: '0xl' }), 1000n);
  const bL1 = new IsubBiller(chainL, SIG, sqlBillerStore(dbL, 'm-lock'), {});
  const bL2 = new IsubBiller(chainL, SIG, sqlBillerStore(dbL, 'm-lock'), {});
  await bL1.init();
  let lockedOut = false;
  try {
    await bL2.init();
  } catch {
    lockedOut = true;
  }
  check(lockedOut, 'second biller instance is locked out while the first holds the lock');
  await bL1.close();
  let tookOver = false;
  try {
    await bL2.init();
    tookOver = true;
  } catch {
    /* still locked */
  }
  check(tookOver, 'lock released → second biller takes over');
  await bL2.close();

  console.log(`\n✅ biller smoke passed — ${checks} assertions (mem + SQL; incl. lost-ack/crash recovery + lock)`);
}

main().catch((e) => {
  console.error('\n❌ biller smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

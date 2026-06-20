// Relationship-index smoke — fully headless (no chain). Proves the dashboard read API that
// gRPC cannot serve: merchant→plans, subscriber→mandates (ACROSS merchants), plan→mandates
// (the plan↔user mapping), owner→accounts — populated by write-time capture, re-derived from
// chain point-reads, idempotent, and correctly partitioned by address.
//
// Run: `npm run relations:smoke` (sets --experimental-sqlite for node:sqlite).
import { openDb } from '../src/db';
import { IsubIndex, type RelationChain } from '../src/relations';
import type { PlanState, MandateState, AccountState } from '../src/types';
import { MandateStatus, type ChargeMode } from '../src/constants';

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}

const KEEPER = '0xkeeper';
const PAYG = 1 as ChargeMode;

function plan(id: string, merchant: string, active = true): PlanState {
  return { id, merchant, mode: PAYG, price: 0n, intervalMs: 0n, rateCap: 1000n, rateWindowMs: 86_400_000n, keeper: KEEPER, active };
}
function account(id: string, owner: string): AccountState {
  return { id, owner, balance: 1_000_000n };
}
function mandate(id: string, p: { accountId: string; subscriber: string; merchant: string; planId: string; spentTotal?: bigint; chargeSeq?: bigint }): MandateState {
  return {
    id, accountId: p.accountId, subscriber: p.subscriber, merchant: p.merchant, planId: p.planId,
    mode: PAYG, price: 0n, intervalMs: 0n, lastChargedMs: 0n, rateCap: 1000n, rateWindowMs: 86_400_000n,
    windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: KEEPER, spentTotal: p.spentTotal ?? 0n,
    totalBudget: 10_000n, expiryMs: 0n, chargeSeq: p.chargeSeq ?? 0n, refundedTotal: 0n,
    maxPerCharge: 1000n, notBeforeMs: 0n, status: MandateStatus.Active,
  };
}

/** A canned chain — the index point-reads from these maps. Mutate to test re-ingest (upsert). */
class MockChain implements RelationChain {
  plans = new Map<string, PlanState>();
  mandates = new Map<string, MandateState>();
  accounts = new Map<string, AccountState>();
  reads = 0;
  async getPlan(id: string): Promise<PlanState> { this.reads++; const v = this.plans.get(id); if (!v) throw new Error(`no plan ${id}`); return v; }
  async getMandate(id: string): Promise<MandateState> { this.reads++; const v = this.mandates.get(id); if (!v) throw new Error(`no mandate ${id}`); return v; }
  async getAccount(id: string): Promise<AccountState> { this.reads++; const v = this.accounts.get(id); if (!v) throw new Error(`no account ${id}`); return v; }
}

// merchants M1, M2 · subscribers S1, S2 · S1 subscribes to BOTH merchants (cross-merchant).
const M1 = '0xm1', M2 = '0xm2', S1 = '0xs1', S2 = '0xs2';

async function main(): Promise<void> {
  const chain = new MockChain();
  chain.plans.set('0xP1', plan('0xP1', M1));
  chain.plans.set('0xP2', plan('0xP2', M1));
  chain.plans.set('0xP3', plan('0xP3', M2));
  chain.accounts.set('0xA1', account('0xA1', S1));
  chain.accounts.set('0xA2', account('0xA2', S2));
  chain.mandates.set('0xD1', mandate('0xD1', { accountId: '0xA1', subscriber: S1, merchant: M1, planId: '0xP1' }));
  chain.mandates.set('0xD2', mandate('0xD2', { accountId: '0xA2', subscriber: S2, merchant: M1, planId: '0xP1' }));
  chain.mandates.set('0xD3', mandate('0xD3', { accountId: '0xA1', subscriber: S1, merchant: M2, planId: '0xP3' }));

  const db = openDb(':memory:');
  let clock = 1000;
  const index = new IsubIndex(chain, db, () => clock++);

  console.log('• write-time capture (ingest re-derives each row from chain)');
  for (const id of ['0xP1', '0xP2', '0xP3']) await index.ingestPlan(id);
  for (const id of ['0xD1', '0xD2', '0xD3']) await index.ingestMandate(id); // also auto-captures accounts
  check(chain.reads >= 6 + 3, 'ingest point-read the chain (plans + mandates + auto-account reads)');

  console.log('\n• merchant → plans (partitioned by merchant address)');
  check(index.plansByMerchant(M1).map((r) => r.planId).sort().join() === '0xP1,0xP2', 'M1 sees exactly its 2 plans');
  check(index.plansByMerchant(M2).map((r) => r.planId).join() === '0xP3', 'M2 sees exactly its 1 plan (isolation)');
  check(index.plansByMerchant('0xnobody').length === 0, 'a merchant with no plans gets []');

  console.log('\n• subscriber → mandates ACROSS merchants (the view gRPC cannot build)');
  const s1 = index.mandatesBySubscriber(S1).map((r) => r.mandateId).sort();
  check(s1.join() === '0xD1,0xD3', 'S1 sees both mandates — one on M1, one on M2 (cross-merchant)');
  check(new Set(index.mandatesBySubscriber(S1).map((r) => r.merchant)).size === 2, 'S1 mandates span 2 distinct merchants');
  check(index.mandatesBySubscriber(S2).map((r) => r.mandateId).join() === '0xD2', 'S2 sees only its own mandate');

  console.log('\n• plan → mandates (the plan↔user mapping)');
  check(index.mandatesByPlan('0xP1').map((r) => r.subscriber).sort().join() === `${S1},${S2}`, 'P1 maps to both subscribers S1 + S2');
  check(index.mandatesByPlan('0xP3').map((r) => r.subscriber).join() === S1, 'P3 maps to S1 only');
  check(index.mandatesByMerchant(M1).length === 2 && index.mandatesByMerchant(M2).length === 1, 'merchant → mandates partitions correctly');

  console.log('\n• owner → accounts (auto-captured during mandate ingest)');
  check(index.accountsByOwner(S1).map((r) => r.accountId).join() === '0xA1', 'S1 owns A1 (captured via ingestMandate, no explicit account ingest)');
  check(index.accountsByOwner(S2).map((r) => r.accountId).join() === '0xA2', 'S2 owns A2');

  console.log('\n• typed rows: bigint fields come back as bigint, flags as boolean');
  const p1 = index.plansByMerchant(M1).find((r) => r.planId === '0xP1')!;
  check(typeof p1.rateCap === 'bigint' && p1.rateCap === 1000n, 'PlanRow.rateCap is a bigint');
  check(p1.active === true, 'PlanRow.active is a boolean');
  const d1 = index.mandate('0xD1')!;
  check(typeof d1.totalBudget === 'bigint' && d1.totalBudget === 10_000n, 'MandateRow.totalBudget is a bigint');
  check(index.mandate('0xnope') === null, 'mandate(unknown id) → null');

  console.log('\n• idempotent re-ingest (upsert by id — refresh fields, never duplicate)');
  chain.mandates.set('0xD1', mandate('0xD1', { accountId: '0xA1', subscriber: S1, merchant: M1, planId: '0xP1', spentTotal: 4_321n, chargeSeq: 7n }));
  await index.ingestMandate('0xD1');
  check(index.mandatesByPlan('0xP1').length === 2, 'P1 still has exactly 2 mandates after re-ingest (no dup)');
  const d1b = index.mandate('0xD1')!;
  check(d1b.spentTotal === 4_321n && d1b.chargeSeq === 7n, 'mutated on-chain fields (spent/seq) refreshed on re-ingest');
  chain.plans.set('0xP2', plan('0xP2', M1, false)); // merchant deactivated P2
  await index.ingestPlan('0xP2');
  check(index.plansByMerchant(M1).length === 2, 'M1 still has 2 plans after re-ingest');
  check(index.plansByMerchant(M1).find((r) => r.planId === '0xP2')!.active === false, 'P2 active=false reflected after re-ingest');

  db.close();
  console.log(`\n✅ relations smoke passed — ${checks} assertions (merchant→plans · subscriber→mandates × N merchants · plan↔user · owner→accounts)`);
}

main().catch((e) => {
  console.error('\n❌ relations smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

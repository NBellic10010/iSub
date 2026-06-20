// Seed a MOCK subscription into the relationship index for UI testing — WITHOUT an on-chain mandate.
//
// The index normally re-derives every row from chain (ingest* calls getPlan/getMandate/getAccount),
// so there is no "insert arbitrary mock" path through the API. Here we feed it a STUB chain that
// returns fabricated objects, so a row lands in the gateway DB and the subscriber portal can DISCOVER
// it via `/relations/mandates?subscriber=`.
//
// ⚠ The subscriber dashboard re-reads chain TRUTH (`getMandatesResolved`) to render, so a purely-mock
// mandate id (not a real on-chain object) shows in the list but as "unreadable". To render fully,
// point the ids at a REAL on-chain mandate, or add an index-row fallback to the dashboard.
//
// Run: `npm run mock:seed`  (override: SUBSCRIBER=0x… ISUB_INDEX_DB=path npm run mock:seed)
import { IsubIndex, type RelationChain } from '../src/relations';
import { ChargeMode, MandateStatus } from '../src/constants';
import { openDb } from '../src/db';
import type { PlanState, MandateState, AccountState } from '../src/types';

const SUBSCRIBER = process.env.SUBSCRIBER ?? '0x5c2b3348b8d952cac541e01755bcfa9f562cbb6fd098287c11658ae9724692fe';
const MERCHANT = '0x' + 'ac'.repeat(32);
const PLAN = '0x' + 'b1'.repeat(32);
const ACCOUNT = '0x' + 'a0'.repeat(32);
const MANDATE = '0x' + 'd1'.repeat(32);
const DB_PATH = process.env.ISUB_INDEX_DB ?? 'isub-index.testnet.db';

class StubChain implements RelationChain {
  async getPlan(): Promise<PlanState> {
    return { id: PLAN, merchant: MERCHANT, mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, rateCap: 100_000_000n, rateWindowMs: 3_600_000n, keeper: MERCHANT, active: true };
  }
  async getMandate(): Promise<MandateState> {
    return {
      id: MANDATE, accountId: ACCOUNT, subscriber: SUBSCRIBER, merchant: MERCHANT, planId: PLAN,
      mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
      rateCap: 100_000_000n, rateWindowMs: 3_600_000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: MERCHANT,
      spentTotal: 41_000_000n, totalBudget: 200_000_000n, expiryMs: BigInt(Date.now() + 30 * 86_400_000),
      chargeSeq: 2n, refundedTotal: 0n, maxPerCharge: 100_000_000n, notBeforeMs: 0n, status: MandateStatus.Active,
    };
  }
  async getAccount(): Promise<AccountState> {
    return { id: ACCOUNT, owner: SUBSCRIBER, balance: 259_000_000n };
  }
}

async function main(): Promise<void> {
  const db = openDb(DB_PATH);
  const idx = new IsubIndex(new StubChain(), db);
  await idx.ingestPlan(PLAN);
  await idx.ingestMandate(MANDATE); // also captures the account (owner = subscriber)

  const got = idx.mandatesBySubscriber(SUBSCRIBER);
  console.log(`✓ seeded mock subscription into ${DB_PATH}`);
  console.log(`  subscriber ${SUBSCRIBER}`);
  console.log(`  mandate    ${MANDATE}`);
  console.log(`  index now returns ${got.length} mandate(s) for this subscriber`);
  console.log(`  query:     GET /relations/mandates?subscriber=${SUBSCRIBER}`);
  db.close();
}

main().catch((e) => {
  console.error('mock-seed failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

// Relationship-index HTTP smoke — headless (NO chain, NO localnet). Proves the FULL frontend
// path: thin `@isubpay/sdk/client` → IsubGateway HTTP routes → IsubIndex → one-call relationship
// answer, including api-key scoping, public address-keyed reads, and bigint-over-the-wire
// (every on-chain u64 arrives as a decimal STRING — JSON has no bigint).
//
// This is the deterministic CI proof for "前端要查 plan↔用户映射，SDK 一键返回". The live-chain
// version lives in managed-e2e.
//
// Run: `npm run relations-http:smoke` (sets --experimental-sqlite for node:sqlite).
import type { AddressInfo } from 'node:net';
import { IsubGateway } from '../src/gateway';
import { IsubIndex, type RelationChain } from '../src/relations';
import { IsubServiceClient } from '../src/client-sdk';
import { openDb } from '../src/db';
import { registerMerchant, sqlBillerStore } from '../src/sql-store';
import type { BillerChain } from '../src/biller';
import type { IsubSigner } from '../src/signer';
import type { PlanState, MandateState, AccountState } from '../src/types';
import { MandateStatus, type ChargeMode } from '../src/constants';

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}

const M1 = '0xmerchant1', M2 = '0xmerchant2', S1 = '0xsub1', S2 = '0xsub2', KEEPER = '0xkeeper';
const PAYG = 1 as ChargeMode;
const API_KEY = 'sk_relations_http';

function plan(id: string, merchant: string): PlanState {
  return { id, merchant, mode: PAYG, price: 0n, intervalMs: 0n, rateCap: 4_200n, rateWindowMs: 86_400_000n, keeper: KEEPER, active: true };
}
function mandate(id: string, accountId: string, subscriber: string, merchant: string, planId: string): MandateState {
  return {
    id, accountId, subscriber, merchant, planId, mode: PAYG, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
    rateCap: 4_200n, rateWindowMs: 86_400_000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: KEEPER,
    spentTotal: 123n, totalBudget: 9_999n, expiryMs: 0n, chargeSeq: 0n, refundedTotal: 0n, maxPerCharge: 1_000n,
    notBeforeMs: 0n, status: MandateStatus.Active,
  };
}

// One mock satisfies BOTH the biller's chain slice and the index's point-read slice.
class MockChain implements BillerChain, RelationChain {
  plans = new Map<string, PlanState>([['0xP1', plan('0xP1', M1)], ['0xP2', plan('0xP2', M1)], ['0xP3', plan('0xP3', M2)]]);
  accounts = new Map<string, AccountState>([['0xA1', { id: '0xA1', owner: S1, balance: 1_000_000n }], ['0xA2', { id: '0xA2', owner: S2, balance: 1_000_000n }]]);
  mandates = new Map<string, MandateState>([
    ['0xD1', mandate('0xD1', '0xA1', S1, M1, '0xP1')],
    ['0xD2', mandate('0xD2', '0xA2', S2, M1, '0xP1')],
    ['0xD3', mandate('0xD3', '0xA1', S1, M2, '0xP3')],
  ]);
  async getPlan(id: string): Promise<PlanState> { const v = this.plans.get(id); if (!v) throw new Error(`no plan ${id}`); return v; }
  async getMandate(id: string): Promise<MandateState> { const v = this.mandates.get(id); if (!v) throw new Error(`no mandate ${id}`); return v; }
  async getAccount(id: string): Promise<AccountState> { const v = this.accounts.get(id); if (!v) throw new Error(`no account ${id}`); return v; }
  async chargeMetered(): Promise<{ digest: string }> { throw new Error('chargeMetered not exercised by the relations test'); }
}

const stubSigner: IsubSigner = { address: KEEPER, signAndExecute: () => { throw new Error('signer not used in relations test'); } };

async function main(): Promise<void> {
  const chain = new MockChain();
  const db = openDb(':memory:');
  registerMerchant(db, { id: 'acme', name: 'Acme', apiKey: API_KEY, payoutAddress: M1 });

  const gateway = new IsubGateway({
    chain,
    keeperSigner: stubSigner,
    db,
    policy: { windowMs: 3_600_000 },
    routing: (mid) => (mid === 'acme' ? { payoutAddress: M1 } : null),
    index: new IsubIndex(chain, db),
  });
  const server = gateway.listen(0);
  const port = await new Promise<number>((r) => server.on('listening', () => r((server.address() as AddressInfo).port)));
  const base = `http://127.0.0.1:${port}`;
  console.log(`• gateway (mock chain) listening ${base}`);

  // The frontend / merchant backend uses ONLY the thin client.
  const c = new IsubServiceClient({ baseUrl: base, apiKey: API_KEY });

  console.log('\n• write-time capture via the thin client (POST /index/*)');
  for (const id of ['0xP1', '0xP2', '0xP3']) await c.indexPlan(id);
  for (const id of ['0xD1', '0xD2', '0xD3']) await c.indexMandate(id);
  check(true, 'indexed 3 plans + 3 mandates through the gateway');

  console.log('\n• merchant dashboard (api-key → my address) — one call each');
  const plans = await c.listPlans();
  check(plans.map((p) => p.planId).sort().join() === '0xP1,0xP2', 'listPlans() → my 2 plans (P3 excluded — different merchant)');
  check(plans.every((p) => p.merchant === M1), 'every listed plan belongs to my address');
  const mans = await c.listMandates();
  check(mans.map((m) => m.mandateId).sort().join() === '0xD1,0xD2', 'listMandates() → my 2 subscribers');

  console.log('\n• plan↔user mapping');
  const onP1 = await c.mandatesByPlan('0xP1');
  check(onP1.map((m) => m.subscriber).sort().join() === `${S1},${S2}`, 'mandatesByPlan(P1) → both subscribers');

  console.log('\n• public subscriber portal reads (address-keyed)');
  const s1 = await c.mandatesBySubscriber(S1);
  check(s1.map((m) => m.mandateId).sort().join() === '0xD1,0xD3', 'mandatesBySubscriber(S1) → both, ACROSS merchants');
  check(new Set(s1.map((m) => m.merchant)).size === 2, 'S1 mandates span 2 merchants over HTTP');
  const accs = await c.accountsByOwner(S1);
  check(accs.map((a) => a.accountId).join() === '0xA1', 'accountsByOwner(S1) → A1 (auto-captured)');

  console.log('\n• bigint-over-the-wire: u64 fields arrive as decimal STRINGS');
  check(typeof plans[0]!.price === 'string' && typeof plans[0]!.rateCap === 'string', 'PlanRowJson u64 fields are strings');
  check(plans.find((p) => p.planId === '0xP1')!.rateCap === '4200', 'rateCap string round-trips ("4200")');
  check(onP1[0]!.totalBudget === '9999' && BigInt(onP1[0]!.totalBudget) === 9_999n, 'MandateRowJson.totalBudget parses back to 9999n');

  console.log('\n• auth: a bad api-key cannot read the merchant dashboard');
  const bad = new IsubServiceClient({ baseUrl: base, apiKey: 'sk_wrong' });
  let threw = false;
  try { await bad.listPlans(); } catch { threw = true; }
  check(threw, 'listPlans() with a bad api-key → throws (401)');

  console.log('\n• public routes + CORS (the wallet dashboards use these WITHOUT an api-key)');
  const opt = await fetch(base, { method: 'OPTIONS' });
  check(opt.status === 204 && opt.headers.get('access-control-allow-origin') === '*', 'OPTIONS preflight → 204 with CORS header');
  const ingPlan = await fetch(`${base}/relations/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: '0xP3' }) });
  check(ingPlan.ok && ingPlan.headers.get('access-control-allow-origin') === '*', 'public POST /relations/plan (no api-key) → 200 + CORS');
  const ingMan = await fetch(`${base}/relations/mandate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandateId: '0xD3' }) });
  check(ingMan.ok, 'public POST /relations/mandate (no api-key) → 200');
  const pubPlans = (await (await fetch(`${base}/relations/plans?merchant=${M2}`)).json()) as { planId: string }[];
  check(pubPlans.some((p) => p.planId === '0xP3'), 'public GET /relations/plans?merchant → returns it (no api-key)');

  console.log('\n• per-mandate usage chart (GET /usage · /charges by mandate id)');
  const store = sqlBillerStore(db, 'acme');
  await store.recordUsage({ usageId: 'u-a', mandateId: '0xD1', amount: 1_000_000n, atMs: 1000, meterKey: 'tokens.in', qty: 5000n, rateCardVersion: 1 });
  await store.recordUsage({ usageId: 'u-b', mandateId: '0xD1', amount: 2_000_000n, atMs: 2000, meterKey: 'tokens.out', qty: 1000n, rateCardVersion: 1 });
  await store.appendJournal({ at: 3000, mandateId: '0xD1', kind: 'charged', amount: '3000000', seq: 1 });
  const usage = (await (await fetch(`${base}/usage?mandateId=0xD1`)).json()) as { amount: string; meterKey: string; qty: string }[];
  check(usage.length === 2 && usage[0]!.amount === '1000000' && usage[1]!.amount === '2000000', 'GET /usage?mandateId → 2 points oldest-first, amounts as strings');
  check(usage[0]!.meterKey === 'tokens.in' && usage[0]!.qty === '5000', 'usage carries meter_key + qty provenance');
  const ch = (await (await fetch(`${base}/charges?mandateId=0xD1`)).json()) as { amount: string; kind: string }[];
  check(ch.length === 1 && ch[0]!.amount === '3000000' && ch[0]!.kind === 'charged', 'GET /charges?mandateId → the settlement (kind=charged)');
  const empty = (await (await fetch(`${base}/usage?mandateId=0xNONE`)).json()) as unknown[];
  check(Array.isArray(empty) && empty.length === 0, 'GET /usage for an unknown mandate → []');

  await gateway.stop();
  server.close();
  db.close();
  console.log(`\n✅ relations HTTP smoke passed — ${checks} assertions (thin client → gateway → index, end to end)`);
}

main().catch((e) => {
  console.error('\n❌ relations HTTP smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

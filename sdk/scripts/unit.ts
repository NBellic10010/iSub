// Network-free unit tests for the backend hardening (K-1..K-6). No chain, no RPC —
// pure logic with stubs + a temp filesystem. Run: `npm run test:unit`.
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileStore } from '../src/store-file';
import { memoryStore } from '../src/store';
import { IsubKeeper, ChargeMode, MandateStatus, scheduleLag, priceUsage, priceUsageMulti, assertValidRateCard, assertRateCardFits } from '../src/index';
import type { IsubClient, IsubSigner, MandateState, RateCard } from '../src/index';
import { IsubAgent, type SpendPolicy } from '../src/agent';
import { IsubBiller, memBillerStore, type BillerChain } from '../src/biller';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.log('  ✗', label); }
}
async function rejects(p: Promise<unknown>, label: string): Promise<void> {
  try { await p; check(false, `${label} (expected throw, got none)`); }
  catch { check(true, label); }
}
function rejectsSync(fn: () => unknown, label: string): void {
  try { fn(); check(false, `${label} (expected throw, got none)`); }
  catch { check(true, label); }
}
const tmp = (): string => mkdtempSync(join(tmpdir(), 'isub-keeper-'));

// ===== store-file: K-4 journal tolerance + K-3 lock liveness =====
async function testStore(): Promise<void> {
  console.log('\n• store-file (K-4 journal tolerance, K-3 lock liveness)');

  // K-4: a truncated/garbage trailing line (crash mid-append) must not brick readJournal.
  {
    const dir = tmp();
    const s = fileStore(dir);
    await s.appendJournal({ at: 1, mandateId: '0xa', kind: 'charged', seq: 1 });
    await s.appendJournal({ at: 2, mandateId: '0xa', kind: 'charged', seq: 2 });
    appendFileSync(join(dir, 'journal.jsonl'), '{"at":3,"mandateId":"0xa","kind":"char'); // partial line
    const j = await s.readJournal();
    check(j.length === 2, `readJournal tolerates the truncated tail line (got ${j.length} good entries, want 2)`);
    rmSync(dir, { recursive: true, force: true });
  }

  // K-3 + K-2 mechanism: a lock whose recorded pid is ALIVE blocks a second acquire.
  {
    const dir = tmp();
    const a = fileStore(dir);
    const b = fileStore(dir);
    await a.acquireLock!();
    await rejects(b.acquireLock!(), 'second acquireLock throws while holder pid is alive');
    check(existsSync(join(dir, 'keeper.lock')), 'holder lock left intact after the blocked acquire');
    await a.releaseLock!();
    let ok = true;
    try { await b.acquireLock!(); } catch { ok = false; }
    check(ok, 'acquire succeeds once the holder releases');
    rmSync(dir, { recursive: true, force: true });
  }

  // K-3: a lock with a DEAD pid is taken over immediately (no 120s stale-timeout wait).
  {
    const dir = tmp();
    writeFileSync(join(dir, 'keeper.lock'), '999999\n'); // pid not running; fresh mtime
    const s = fileStore(dir);
    let ok = true;
    try { await s.acquireLock!(); } catch { ok = false; }
    check(ok, 'dead-pid lock taken over immediately (pid liveness, not just time)');
    rmSync(dir, { recursive: true, force: true });
  }

  // K-3 regression: a time-stale lock is freed even if its pid is alive (held = fresh AND alive).
  {
    const dir = tmp();
    writeFileSync(join(dir, 'keeper.lock'), `${process.pid}\n`); // our own (alive) pid…
    const old = (Date.now() - 5 * 60_000) / 1000; // …but mtime 5 min ago
    utimesSync(join(dir, 'keeper.lock'), old, old);
    const s = fileStore(dir);
    let ok = true;
    try { await s.acquireLock!(); } catch { ok = false; }
    check(ok, 'time-stale lock freed even with a live pid (AND semantics)');
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===== keeper: K-1 isolation + K-2 fail-fast =====
const DUE_FIXED: MandateState = {
  id: '0xGOOD', accountId: '0xACCT', subscriber: '0xu', merchant: '0xm', planId: '0xp',
  mode: ChargeMode.Fixed, price: 100n, intervalMs: 1000n, lastChargedMs: 0n,
  rateCap: 0n, rateWindowMs: 0n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: '0xk',
  spentTotal: 0n, totalBudget: 1000n, expiryMs: 9_000_000n, chargeSeq: 0n, refundedTotal: 0n,
  maxPerCharge: 100n, notBeforeMs: 0n, status: MandateStatus.Active,
};
const DUMMY_SIGNER = { address: '0xk', signAndExecute: async () => { throw new Error('unused'); } } as IsubSigner;

async function testKeeperIsolation(): Promise<void> {
  console.log('\n• keeper K-1 (one bad/missing id must not abort the sweep)');
  const goodId = DUE_FIXED.id;
  const badId = '0xBAD';
  let chargeCalls = 0;
  const stub = {
    getMandatesResolved: async (ids: string[]) =>
      ids.map((id) => ({ id, mandate: id === goodId ? DUE_FIXED : null })),
    getAccount: async () => ({ id: DUE_FIXED.accountId, owner: '0xu', balance: 500n }),
    charge: async () => { chargeCalls++; return { digest: '0xdig' }; },
  } as unknown as IsubClient;

  const keeper = new IsubKeeper(stub, DUMMY_SIGNER, [goodId, badId], { store: memoryStore(), dueMarginMs: 0 });
  let threw = false;
  let r: Awaited<ReturnType<IsubKeeper['tick']>> | undefined;
  try { r = await keeper.tick(1_000_000); } catch { threw = true; }
  check(!threw, 'tick() did NOT throw despite a null (missing/deleted) mandate in the set');
  check(!!r && r.charged.some((c) => c.mandateId === goodId), 'the good mandate still charged');
  check(chargeCalls === 1, `charge called exactly once (got ${chargeCalls})`);
  check(!!r && r.skipped.some((s) => s.mandateId === badId && /unreadable/.test(s.reason)), 'bad id isolated as a skip, not fatal');
}

async function testKeeperLock(): Promise<void> {
  console.log('\n• keeper K-2 (lock contention fails fast, no lock theft)');
  const dir = tmp();
  const stub = { getMandatesResolved: async () => [], getAccount: async () => ({ balance: 0n }), charge: async () => ({ digest: '' }) } as unknown as IsubClient;
  const k1 = new IsubKeeper(stub, DUMMY_SIGNER, [], { store: fileStore(dir) });
  await k1.init();
  const k2 = new IsubKeeper(stub, DUMMY_SIGNER, [], { store: fileStore(dir) });
  await rejects(k2.init(), 'second keeper init() fails fast while the first holds the lock');
  await k2.close(); // must be a no-op — k2 never acquired, so it must not delete k1's lock
  check(existsSync(join(dir, 'keeper.lock')), 'k2.close() did not steal/delete the holder lock');
  await k1.close();
  check(!existsSync(join(dir, 'keeper.lock')), 'k1.close() released its lock');
  rmSync(dir, { recursive: true, force: true });
}

// ===== decoupling: the core barrel must stay Node-dependency-free (isomorphic) =====
// Browser / agent consumers import the core (`@isub/sdk`); only the declared Node
// shells — the server-only SUBPATH modules (@isub/sdk/store-file, /webhook, /db,
// /sql-store, /service, /gateway, /mcp), none re-exported from the index — may touch node:*.
// This guard fails if any OTHER src file imports node:*, so the index can't silently
// pull a Node dependency and break browser bundling.
function testCoreIsomorphism(): void {
  console.log('\n• decoupling (core barrel is Node-dependency-free)');
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  // Server-only subpath modules (NOT exported from src/index.ts) — node:* is expected here.
  const NODE_SHELLS = new Set(['store-file.ts', 'webhook.ts', 'db.ts', 'sql-store.ts', 'service.ts', 'gateway.ts', 'mcp.ts']);
  const offenders: string[] = [];
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.ts') || NODE_SHELLS.has(f)) continue;
    const code = readFileSync(join(srcDir, f), 'utf8');
    if (/\bfrom\s+['"]node:/.test(code) || /\brequire\(\s*['"]node:/.test(code)) offenders.push(f);
  }
  check(offenders.length === 0, `no core src file imports node:* (offenders: ${offenders.join(', ') || 'none'})`);
}

// ===== agent shell: model A (allow-list, terms-bound) + B (open, envelope-only) =====
async function testAgent(): Promise<void> {
  console.log('\n• agent shell (model A allow-list + B open discovery)');
  const ACCT = '0xACCT';
  let lastFixed: Record<string, unknown> | undefined;
  let lastMetered: Record<string, unknown> | undefined;
  const revoked: string[] = [];
  const stub = {
    authorizeFixed: async (_s: unknown, p: Record<string, unknown>) => { lastFixed = p; return { digest: '0xd', mandateId: '0xMF' }; },
    authorizeMetered: async (_s: unknown, p: Record<string, unknown>) => { lastMetered = p; return { digest: '0xd', mandateId: '0xMP' }; },
    revoke: async (_s: unknown, p: { mandateId: string }) => { revoked.push(p.mandateId); return { digest: '0xd' }; },
    quoteFromPlan: async (id: string) => ({ id, merchant: '0xOPEN', mode: ChargeMode.Fixed, price: 10n, intervalMs: 1000n, rateCap: 0n, rateWindowMs: 0n, keeper: '0xK', active: true }),
    getAccount: async () => ({ id: ACCT, owner: '0xu', balance: 500n }),
    getMandates: async (ids: string[]) => ids.map((id) => ({ id, accountId: ACCT, status: MandateStatus.Active, merchant: '0xM', totalBudget: 1000n, spentTotal: 100n })),
  } as unknown as IsubClient;
  const signer = { address: '0xagent', signAndExecute: async () => { throw new Error('unused'); } } as IsubSigner;
  const policy: SpendPolicy = {
    accountId: ACCT,
    allowed: [
      { name: 'feed', planId: '0xFP', merchant: '0xM', mode: ChargeMode.Fixed, price: 100n, intervalMs: 1000n, maxTotalBudget: 1000n },
      { name: 'gpu', planId: '0xPP', merchant: '0xM', mode: ChargeMode.Payg, rateCap: 50n, rateWindowMs: 1000n, keeper: '0xK', maxTotalBudget: 1000n, maxPerCharge: 50n },
    ],
  };
  const agent = new IsubAgent(stub, signer, policy, () => 1_000_000);

  const r1 = await agent.subscribe({ service: 'feed', budget: 500n });
  check(r1.ok && r1.mandateId === '0xMF' && r1.terms === 'approved', 'A: subscribe to allow-listed Fixed service ok');
  check(lastFixed?.expectedPrice === 100n && lastFixed?.expectedMerchant === '0xM' && lastFixed?.totalBudget === 500n,
    'A: expected_price/merchant bound from the human-approved entry (terms-binding real)');

  const r2 = await agent.subscribe({ service: 'gpu', budget: 500n });
  check(r2.ok && r2.mode === 'payg', 'A: subscribe to allow-listed PAYG service ok');
  check(lastMetered?.expectedRateCap === 50n && lastMetered?.expectedKeeper === '0xK' && lastMetered?.expectedMerchant === '0xM',
    'A: expected_rateCap/keeper/merchant all bound');

  const r3 = await agent.subscribe({ service: '0xUNKNOWN', budget: 100n });
  check(!r3.ok && /not in the agent/.test(r3.reason ?? ''), 'A: non-allow-listed service rejected (open discovery off)');

  const r4 = await agent.subscribe({ service: 'feed', budget: 9999n });
  check(!r4.ok && /cap/.test(r4.reason ?? ''), 'A: budget over the approved per-service cap rejected');

  const bs = await agent.budgetStatus();
  check(bs.balance === 500n && bs.subscriptions.length === 2 && bs.overAuthorized, 'budget_status reports balance + per-subscription exposure');

  const u = await agent.unsubscribe('0xMF');
  check(u.ok && revoked.includes('0xMF'), 'unsubscribe revokes the mandate');

  // Model B: open discovery (off by default) — only enabled here explicitly.
  const openAgent = new IsubAgent(stub, signer, { accountId: ACCT, allowed: [], allowOpen: true }, () => 1_000_000);
  const r5 = await openAgent.subscribe({ service: '0xOPENPLAN', budget: 200n });
  check(r5.ok && r5.terms === 'unverified-open', 'B: open-discovery subscribe ok, flagged unverified-open');
  check(lastFixed?.expectedMerchant === '0xOPEN', 'B: terms derived from the plan (envelope is the guard, not terms-binding)');
}

// ===== scheduleLag: make silent revenue-loss visible (Phase 1) =====
async function testLag(): Promise<void> {
  console.log('\n• scheduleLag (arrears visibility: fundable vs starved, trial/budget false-positive guards)');
  const NOW = 1_000_000;
  const mk = (over: Partial<MandateState>): MandateState => ({ ...DUE_FIXED, ...over });
  const A1 = '0xA1';
  const A2 = '0xA2';
  const mandates = new Map<string, MandateState>([
    ['0xON', mk({ id: '0xON', accountId: A1, lastChargedMs: 999_500n })], // dueAt 1_000_500 > now → on schedule
    ['0xTRIAL', mk({ id: '0xTRIAL', accountId: A1, lastChargedMs: 0n, notBeforeMs: 2_000_000n })], // first-charge window in the future
    ['0xFUND', mk({ id: '0xFUND', accountId: A1, lastChargedMs: 900_000n })], // due (dueAt 901_000), account funded
    ['0xDRY', mk({ id: '0xDRY', accountId: A2, lastChargedMs: 900_000n })], // due, account empty
    ['0xPAUSE', mk({ id: '0xPAUSE', accountId: A1, status: MandateStatus.Paused })],
    ['0xEXP', mk({ id: '0xEXP', accountId: A1, expiryMs: 500_000n })],
    ['0xDONE', mk({ id: '0xDONE', accountId: A1, lastChargedMs: 900_000n, spentTotal: 950n, totalBudget: 1000n })], // would be due, but budget exhausted
    ['0xPAYG', mk({ id: '0xPAYG', accountId: A1, mode: ChargeMode.Payg, rateCap: 50n, rateWindowMs: 1000n, windowStartMs: 999_900n, windowSpent: 20n, totalBudget: 1000n, spentTotal: 100n })],
  ]);
  for (let i = 0; i < 120; i++) mandates.set(`0xBULK${i}`, mk({ id: `0xBULK${i}`, accountId: A1, lastChargedMs: 999_500n })); // exercise ≤50 chunking

  let resolveCalls = 0;
  let acctCalls = 0;
  const chain = {
    getMandatesResolved: async (ids: string[]) => {
      resolveCalls++;
      return ids.map((id) => ({ id, mandate: mandates.get(id) ?? null }));
    },
    getAccount: async (id: string) => {
      acctCalls++;
      return { id, owner: '0xu', balance: id === A2 ? 0n : 500n };
    },
  };
  const ids = [...mandates.keys(), '0xMISS']; // 0xMISS → null (unreadable)
  const rep = await scheduleLag(chain, ids, { nowMs: NOW, dueMarginMs: 0 });
  const by = (id: string) => rep.rows.find((r) => r.mandateId === id)!;

  check(by('0xON').state === 'on_schedule', 'not-yet-due Fixed → on_schedule');
  check(by('0xTRIAL').state === 'on_schedule', 'trial window (notBefore in future) → on_schedule (no false positive)');
  check(by('0xFUND').state === 'arrears_fundable' && by('0xFUND').owedRecoverable === 100n, 'due + funded → arrears_fundable, owed = one price');
  check(by('0xFUND').lagMs === 99_000, `lagMs = now - dueAt (got ${by('0xFUND').lagMs})`);
  check(by('0xDRY').state === 'arrears_starved' && by('0xDRY').owedRecoverable === 0n, 'due + dry account → arrears_starved, nothing recoverable by us');
  check(by('0xPAUSE').state === 'paused', 'paused → not arrears');
  check(by('0xEXP').state === 'expired', 'expired → not arrears');
  check(by('0xDONE').state === 'on_schedule', 'budget exhausted → on_schedule (completed, not behind)');
  check(by('0xPAYG').state === 'payg_headroom' && by('0xPAYG').lagMs === 0, 'PAYG → headroom, never interval lag');
  check(rep.unreadable === 1, 'unreadable id counted, not fatal');
  check(rep.behindFundable === 1 && rep.behindStarved === 1 && rep.owedRecoverableUpperBound === 100n, 'aggregate: 1 fundable / 1 starved / owed upper-bound = one price');
  check(resolveCalls === 3, `ids chunked ≤50/call (129 ids → 3 calls, got ${resolveCalls})`);
  check(acctCalls === 2, `one balance read per account, cached (got ${acctCalls})`);
}

// ===== PAYG pricing layer: pure RateCard math =====
function testPricing(): void {
  console.log('\n• pricing (pure RateCard math: rational, ceil default, included/min, multi-meter, guards)');
  const card: RateCard = {
    version: 1,
    meters: {
      tokens: { key: 'tokens', priceNum: 3n, priceDen: 1000n, units: 1n }, // 3 MIST / 1000 tokens
      calls: { key: 'calls', priceNum: 500n, priceDen: 1n, units: 1n }, // 500 MIST / call
      gb: { key: 'gb', priceNum: 10n, priceDen: 1n, units: 1n, includedQty: 2n, minCharge: 5n },
    },
  };
  assertValidRateCard(card);
  check(priceUsage(card, 'tokens', 1000n) === 3n, 'linear exact: 1000 tokens @ 3/1000 = 3');
  check(priceUsage(card, 'tokens', 1n) === 1n, 'sub-unit rounds UP (ceil default): 1 token → 1 MIST (anti-bleed)');
  check(priceUsage({ ...card, rounding: 'floor' }, 'tokens', 1n) === 0n, 'floor opt-in: 1 token → 0');
  check(priceUsage(card, 'calls', 3n) === 1500n, 'per-call: 3 calls → 1500');
  check(priceUsage(card, 'gb', 2n) === 0n, 'includedQty fully covers (2gb,2 incl) → free, minCharge NOT applied');
  check(priceUsage(card, 'gb', 5n) === 30n, 'includedQty partial: (5-2)*10 = 30');
  const minCard: RateCard = { version: 1, meters: { m: { key: 'm', priceNum: 1n, priceDen: 1000n, units: 1n, minCharge: 10n } } };
  check(priceUsage(minCard, 'm', 500n) === 10n, 'minCharge floors a tiny billable charge up to 10');
  check(priceUsage(minCard, 'm', 0n) === 0n, 'zero qty → 0 (minCharge not applied)');
  const r = priceUsageMulti(card, [{ meterKey: 'tokens', qty: 2000n }, { meterKey: 'calls', qty: 1n }]);
  check(r.amount === 506n && r.lines.length === 2, 'multi-meter sums: 2000 tokens(6) + 1 call(500) = 506');
  check(r.lines.reduce((s, l) => s + l.amount, 0n) === r.amount, 'per-line amounts sum EXACTLY to total');
  check(r.cardVersion === 1, 'PriceResult carries cardVersion provenance');
  rejectsSync(() => priceUsage(card, 'nope', 1n), 'unknown meter throws');
  rejectsSync(() => priceUsage(card, 'tokens', -1n), 'negative qty throws');
  rejectsSync(() => assertValidRateCard({ version: 1, meters: { x: { key: 'x', priceNum: 1n, priceDen: 0n, units: 1n } } }), 'priceDen<=0 rejected at construction');
  rejectsSync(() => assertValidRateCard({ version: 1, meters: { x: { key: 'y', priceNum: 1n, priceDen: 1n, units: 1n } } }), 'key/slot mismatch rejected');
  rejectsSync(() => assertValidRateCard({ version: 1, meters: {} }), 'empty card rejected');
  rejectsSync(() => priceUsage({ version: 1, meters: { big: { key: 'big', priceNum: 1n << 64n, priceDen: 1n, units: 1n } } }, 'big', 1n), 'over-u64 priced amount throws at ingest (not at flush)');
  check(priceUsage(card, 'tokens', 1234n) === priceUsage(card, 'tokens', 1234n), 'deterministic: same inputs → same bigint');
}

// ===== assertRateCardFits: advisory liveness =====
function testPricingFits(): void {
  console.log('\n• pricing fits (advisory: reject dead-on-arrival cards, fits != carry guarantee)');
  const payg = { mode: ChargeMode.Payg, rateCap: 1000n, rateWindowMs: 1000n, maxPerCharge: 100n, totalBudget: 5000n, spentTotal: 0n };
  const good: RateCard = { version: 1, meters: { c: { key: 'c', priceNum: 50n, priceDen: 1n, units: 1n } } };
  check(assertRateCardFits(good, payg).length === 0, 'sane card under generous mandate → no problems');
  const badMin: RateCard = { version: 1, meters: { c: { key: 'c', priceNum: 1n, priceDen: 1n, units: 1n, minCharge: 200n } } };
  check(assertRateCardFits(badMin, payg).some((p) => p.code === 'min_exceeds_max_per_charge'), 'minCharge>maxPerCharge flagged (never settles, #24)');
  const badUnit: RateCard = { version: 1, meters: { c: { key: 'c', priceNum: 500n, priceDen: 1n, units: 1n } } };
  check(assertRateCardFits(badUnit, payg).some((p) => p.code === 'unit_exceeds_max_per_charge'), 'per-unit price>maxPerCharge flagged');
  check(assertRateCardFits(good, { ...payg, mode: ChargeMode.Fixed })[0]?.code === 'not_payg', 'Fixed mandate → not_payg');
}

// ===== priced ingest + the load-bearing freeze-survives-card-edit regression =====
const PAYG = (over: Partial<MandateState> = {}): MandateState => ({
  ...DUE_FIXED, mode: ChargeMode.Payg, accountId: '0xACCT',
  maxPerCharge: 1_000_000n, totalBudget: 1_000_000n, rateCap: 1_000_000n, rateWindowMs: 10_000n,
  windowStartMs: 0n, windowSpent: 0n, ...over,
});
async function testPricedIngest(): Promise<void> {
  console.log('\n• priced ingest: freeze at ingest, dedup, and freeze survives a card edit through recoverOrphan');

  // (1) freeze + provenance + dedup + zero-reject
  {
    const store = memBillerStore();
    const card: RateCard = { version: 7, meters: { tokens: { key: 'tokens', priceNum: 3n, priceDen: 1000n, units: 1n } } };
    const chain = { getMandate: async () => PAYG(), getAccount: async () => ({ id: '0xACCT', owner: '0xu', balance: 1_000_000n }), chargeMetered: async () => ({ digest: '0xd' }) } as unknown as BillerChain;
    const biller = new IsubBiller(chain, DUMMY_SIGNER, store, { rateCard: card });
    await biller.recordMeteredUsage({ mandateId: '0xM', usageId: 'u1', items: [{ meterKey: 'tokens', qty: 1000n }] });
    const un = await store.unbilled('0xM');
    check(un.length === 1 && un[0]!.amount === 3n, 'priced once at ingest, frozen amount = 3');
    check(un[0]!.meterKey === 'tokens' && un[0]!.qty === 1000n && un[0]!.rateCardVersion === 7, 'provenance (meter/qty/version) stored beside the frozen amount');
    await biller.recordMeteredUsage({ mandateId: '0xM', usageId: 'u1', items: [{ meterKey: 'tokens', qty: 1000n }] });
    check((await store.unbilled('0xM')).length === 1, 'duplicate usageId is a no-op (still one row)');
    await rejects(biller.recordMeteredUsage({ mandateId: '0xM', usageId: 'u0', items: [{ meterKey: 'tokens', qty: 0n }] }), 'zero-priced usage rejected (no phantom row)');
  }

  // (2) THE regression: edit the card mid-window + lose an ack → recoverOrphan must match the FROZEN amount, never re-price.
  {
    const store = memBillerStore();
    const card: RateCard = { version: 1, meters: { tokens: { key: 'tokens', priceNum: 3n, priceDen: 1000n, units: 1n } } };
    let chainSeq = 0n;
    let chargeCalls = 0;
    const chain = {
      getMandate: async () => PAYG({ chargeSeq: chainSeq }),
      getAccount: async () => ({ id: '0xACCT', owner: '0xu', balance: 1_000_000n }),
      chargeMetered: async () => {
        chargeCalls++;
        if (chargeCalls === 1) { chainSeq += 1n; throw new Error('network timeout — ack lost'); } // landed on-chain, ack lost
        return { digest: '0xlate' };
      },
    } as unknown as BillerChain;
    const biller = new IsubBiller(chain, DUMMY_SIGNER, store, { rateCard: card });
    await biller.recordMeteredUsage({ mandateId: '0xM', usageId: 'u1', items: [{ meterKey: 'tokens', qty: 1000n }] }); // frozen = 3
    card.meters = { tokens: { key: 'tokens', priceNum: 9n, priceDen: 1000n, units: 1n } }; // merchant triples the price mid-window
    card.version = 2;
    await biller.flush('0xM', 1000);
    const j = await store.readJournal();
    check(j.find((e) => e.kind === 'submit')?.amount === '3', 'submit journaled the FROZEN amount 3 (not re-priced to 9)');
    const recovered = j.find((e) => e.kind === 'charged' && e.reason === 'recovered');
    check(!!recovered && recovered.amount === '3', 'recoverOrphan matched frozen 3 and back-filled charged (no double charge)');
    check(chargeCalls === 1, 'exactly ONE on-chain charge attempt (recovery did not re-charge)');
    check(!j.some((e) => e.kind === 'fail' && /manual reconcile/.test(e.reason ?? '')), 'NO manual-reconcile strand — freeze invariant held across the card edit');
    check((await store.unbilled('0xM')).length === 0, 'usage marked billed after recovery');
  }
}

async function main(): Promise<void> {
  testCoreIsomorphism();
  await testStore();
  await testKeeperIsolation();
  await testKeeperLock();
  await testAgent();
  await testLag();
  testPricing();
  testPricingFits();
  await testPricedIngest();
  console.log(`\n${failed === 0 ? '✅' : '❌'} backend unit: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\n❌ unit harness crashed:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});

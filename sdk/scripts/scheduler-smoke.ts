// Offline regression for the Scheduler (Architecture A). Fake chain, deterministic clock.
// Covers the four phase transitions + the upgrade consent gate (the non-custodial iron law:
// the merchant may pull LESS silently, but NEVER more without a new signature).
//
//   run: npm run scheduler:smoke

import { IsubScheduler, memoryScheduleStore, ChargeMode, MandateStatus } from '../src/index';
import type { MandateState, IsubSigner, SchedulerChain, SchedulerEvent, RateCard, SchedulePhase } from '../src/index';

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.log('  ✗', label); }
};

const MERCHANT: IsubSigner = { address: '0xMERCHANT', signAndExecute: async () => { throw new Error('unused'); } } as IsubSigner;

const BASE: MandateState = {
  id: '0xM', accountId: '0xACCT', subscriber: '0xSUB', merchant: '0xMERCHANT', planId: '0xPLAN',
  mode: ChargeMode.Fixed, price: 100n, intervalMs: 1000n, lastChargedMs: 0n,
  rateCap: 0n, rateWindowMs: 0n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: '0xK',
  spentTotal: 0n, totalBudget: 1_000_000_000n, expiryMs: 9_000_000_000n, chargeSeq: 0n, refundedTotal: 0n,
  maxPerCharge: 100n, notBeforeMs: 0n, status: MandateStatus.Active,
};
const mk = (over: Partial<MandateState>): MandateState => ({ ...BASE, ...over });

/** A fake chain that mutates in-memory mandates, plus a `charge()` helper that simulates the keeper. */
function fakeChain(initial: MandateState[]) {
  const mandates = new Map<string, MandateState>(initial.map((m) => [m.id, { ...m }]));
  const refunds: { mandateId: string; amount: bigint }[] = [];
  const chain: SchedulerChain = {
    getMandatesResolved: async (ids) => ids.map((id) => ({ id, mandate: mandates.has(id) ? { ...mandates.get(id)! } : null })),
    refund: async (_s, p) => {
      const m = mandates.get(p.mandateId);
      if (!m) throw new Error(`refund on unknown mandate ${p.mandateId}`);
      m.refundedTotal += p.amount;
      refunds.push({ mandateId: p.mandateId, amount: p.amount });
      return { digest: `0xref${refunds.length}` };
    },
  };
  return {
    chain,
    /** simulate the keeper landing one Fixed charge of `mandate.price`. */
    keeperCharge: (id: string): void => { const m = mandates.get(id)!; m.chargeSeq += 1n; m.spentTotal += m.price; },
    addMandate: (m: MandateState): void => { mandates.set(m.id, { ...m }); },
    get: (id: string): MandateState => mandates.get(id)!,
    refundTotal: (): bigint => refunds.reduce((a, r) => a + r.amount, 0n),
    refundCount: (): number => refunds.length,
  };
}

const events: SchedulerEvent[] = [];
const newScheduler = (fk: ReturnType<typeof fakeChain>) =>
  new IsubScheduler(fk.chain, MERCHANT, { store: memoryScheduleStore(), onEvent: (e) => events.push(e) });

// ───────────────────────────────────────────────────────────────────────────
async function scenarioDowngrade(): Promise<void> {
  console.log('\n• A: silent downgrade — refund (price − effective) per charge, baselined & idempotent');
  events.length = 0;
  const fk = fakeChain([mk({ id: '0xD', price: 100n })]);
  const s = newScheduler(fk);
  const phases: SchedulePhase[] = [
    { startMs: 0, kind: 'fixed', price: 100n, label: 'standard' },
    { startMs: 1000, kind: 'fixed', price: 60n, label: 'loyalty' },
  ];
  await s.schedule({ subscriptionId: 'subD', accountId: '0xACCT', planId: '0xPLAN', merchant: '0xMERCHANT', mandateId: '0xD', phases, nowMs: 0 });

  // Two charges at the standard price BEFORE the downgrade — must NOT be refunded.
  fk.keeperCharge('0xD'); fk.keeperCharge('0xD'); // chargeSeq = 2
  await s.tick(500);
  check(fk.refundTotal() === 0n, 'no refund while still on the standard phase');

  // Cross into the loyalty (downgrade) phase: baseline set, nothing refunded yet.
  await s.tick(1000);
  check(s.snapshot()[0]!.cursor === 1 && s.snapshot()[0]!.status === 'active', 'advanced into the downgrade phase');
  check(fk.refundTotal() === 0n, 'pre-downgrade charges are baselined out (not refunded)');

  // One charge on the downgrade phase → refund the 40 delta.
  fk.keeperCharge('0xD'); // seq = 3
  await s.tick(1500);
  check(fk.refundTotal() === 40n, 'refunded exactly the 40 delta for the one post-downgrade charge');

  // Idempotent: a tick with no new charge must not refund again.
  await s.tick(1600);
  check(fk.refundTotal() === 40n && fk.refundCount() === 1, 'no double-refund on a re-tick with no new charge');

  // Two more charges → one batched refund of 80.
  fk.keeperCharge('0xD'); fk.keeperCharge('0xD'); // seq = 5
  await s.tick(1700);
  check(fk.refundTotal() === 120n && fk.refundCount() === 2, 'batched the next two charges into an 80 refund (total 120)');
  check(fk.get('0xD').refundedTotal === 120n, 'on-chain refundedTotal reflects the silent downgrade');
}

// ───────────────────────────────────────────────────────────────────────────
async function scenarioUpgradeConsentGate(): Promise<void> {
  console.log('\n• A: upgrade consent gate — never pull more without a new signature');
  events.length = 0;
  const fk = fakeChain([mk({ id: '0xU', price: 60n })]);
  const s = newScheduler(fk);
  const phases: SchedulePhase[] = [
    { startMs: 0, kind: 'fixed', price: 60n, label: 'basic' },
    { startMs: 1000, kind: 'fixed', price: 100n, label: 'pro' },
  ];
  await s.schedule({ subscriptionId: 'subU', accountId: '0xACCT', planId: '0xPLAN', merchant: '0xMERCHANT', mandateId: '0xU', phases, nowMs: 0 });

  fk.keeperCharge('0xU'); // basic charge, seq 1
  await s.tick(500);
  check(s.snapshot()[0]!.cursor === 0, 'still on basic before the upgrade time');

  // Upgrade time arrives: must FREEZE on the old phase, not advance, and ask for consent.
  await s.tick(1000);
  const snap = s.snapshot()[0]!;
  check(snap.status === 'awaiting_consent', 'status → awaiting_consent at the upgrade boundary');
  check(snap.cursor === 0, 'cursor stays on the old (lower) phase — keeper keeps billing 60');
  const consentEv = events.find((e) => e.type === 'consent.required');
  check(!!consentEv && consentEv.type === 'consent.required' && consentEv.fromPrice === 60n && consentEv.toPrice === 100n,
    'consent.required emitted (60 → 100)');
  check(fk.get('0xU').price === 60n, 'on-chain mandate price is UNCHANGED — no silent over-pull');

  // Keeper keeps charging the old price while we wait; scheduler must do nothing (no refund, no advance).
  fk.keeperCharge('0xU'); // seq 2 at 60
  await s.tick(1100);
  check(s.snapshot()[0]!.cursor === 0 && fk.refundTotal() === 0n, 'while awaiting consent: still billing old price, no refund');

  // Subscriber signs a new mandate at 100 (old revoked in their PTB). Merchant calls applyConsent.
  fk.addMandate(mk({ id: '0xU2', price: 100n, chargeSeq: 0n }));
  await s.applyConsent('subU', '0xU2', 1200);
  const after = s.snapshot()[0]!;
  check(after.status === 'active' && after.mandateId === '0xU2' && after.cursor === 1, 'applyConsent → active, repointed to new mandate, advanced to pro');
  check(events.some((e) => e.type === 'mandate.replaced'), 'mandate.replaced emitted (so the merchant rewires the keeper)');

  // The upgraded mandate (price 100, pro phase 100) bills at full price — no refund.
  fk.keeperCharge('0xU2'); // seq 1 at 100
  await s.tick(1300);
  check(fk.refundTotal() === 0n, 'no refund once on the matching pro phase (effective == ceiling)');
}

// ───────────────────────────────────────────────────────────────────────────
async function scenarioPaygReprice(): Promise<void> {
  console.log('\n• A: PAYG reprice — emit payg.repriced (biller swaps card), no on-chain change');
  events.length = 0;
  const fk = fakeChain([mk({ id: '0xP', price: 50n })]);
  const s = newScheduler(fk);
  const CARD_V2: RateCard = { version: 2, meters: { calls: { key: 'calls', priceNum: 2n, priceDen: 1n, units: 1n } } };
  const phases: SchedulePhase[] = [
    { startMs: 0, kind: 'fixed', price: 50n, label: 'flat' },
    { startMs: 1000, kind: 'payg', rateCard: CARD_V2, label: 'metered' },
  ];
  await s.schedule({ subscriptionId: 'subP', accountId: '0xACCT', planId: '0xPLAN', merchant: '0xMERCHANT', mandateId: '0xP', phases, nowMs: 0 });

  await s.tick(1000);
  check(s.snapshot()[0]!.cursor === 1, 'advanced into the PAYG phase');
  const ev = events.find((e) => e.type === 'payg.repriced');
  check(!!ev && ev.type === 'payg.repriced' && ev.rateCard.version === 2, 'payg.repriced emitted with the new card (v2)');

  // PAYG phases never trigger the Fixed silent-refund path, regardless of mandate.price.
  fk.keeperCharge('0xP');
  await s.tick(1100);
  check(fk.refundTotal() === 0n, 'no spurious refund on a PAYG phase');
}

// ───────────────────────────────────────────────────────────────────────────
async function scenarioTrial(): Promise<void> {
  console.log('\n• A: trial → paid — clean cursor advance, no money action by the scheduler');
  events.length = 0;
  // Trial priced 0; the keeper does not charge during it (gated by not_before, tested in unit.ts).
  const fk = fakeChain([mk({ id: '0xT', price: 100n })]);
  const s = newScheduler(fk);
  const phases: SchedulePhase[] = [
    { startMs: 0, kind: 'fixed', price: 0n, label: 'trial' },
    { startMs: 5000, kind: 'fixed', price: 100n, label: 'standard' },
  ];
  await s.schedule({ subscriptionId: 'subT', accountId: '0xACCT', planId: '0xPLAN', merchant: '0xMERCHANT', mandateId: '0xT', phases, nowMs: 0 });

  // During the trial the keeper fires nothing → no refund (would refund in full if it did = free trial).
  await s.tick(1000);
  check(s.snapshot()[0]!.cursor === 0 && fk.refundTotal() === 0n, 'trial: cursor 0, no charge, no refund');

  // Trial ends → advance to standard (price == mandate ceiling), no refund.
  await s.tick(5000);
  check(s.snapshot()[0]!.cursor === 1, 'advanced trial → standard at trial end');
  check(events.some((e) => e.type === 'phase.advanced' && e.label === 'standard'), 'phase.advanced(standard) emitted');

  // Now the keeper bills the standard price in full.
  fk.keeperCharge('0xT');
  await s.tick(5500);
  check(fk.refundTotal() === 0n, 'standard billed at full price (no refund)');
}

async function main(): Promise<void> {
  await scenarioDowngrade();
  await scenarioUpgradeConsentGate();
  await scenarioPaygReprice();
  await scenarioTrial();
  console.log(`\n${failed === 0 ? '✅' : '❌'} scheduler smoke: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Idempotency & tamper-boundary smoke — what survives "the batch is messed with before it lands."
// A faithful MockChain mirrors the Move `charge_metered` gates (seq idempotency + rate/budget/
// per-charge/balance caps). Three acts map 1:1 to the guarantee table:
//   A. REPLAY a landed batch (stale seq)        → EBadChargeSeq, NO double-charge        (on-chain seq)
//   B. CRASH / lost-ack (charge landed, ack lost) → recoverOrphan marks billed, NO re-charge (seq + journal)
//   C. INFLATE amount over the cap               → EOverRateCap, nothing lands            (on-chain cap)
//      + an UNJOURNALED on-chain charge          → reconcile reports drift (detected, not prevented)
// Deterministic (in-memory). Run: npm run idempotency:smoke
import { IsubAbortError } from '../src/errors';
import { IsubBiller, memBillerStore, type BillerChain } from '../src/biller';
import { reconcile } from '../src/reconcile';
import { ChargeMode, MandateStatus } from '../src/constants';
import type { MandateState, AccountState } from '../src/types';
import type { IsubSigner } from '../src/signer';

// Move abort codes (mirror contracts/sources/subscription.move).
const E_BAD_SEQ = 20;
const E_OVER_RATE_CAP = 8;

const KEEPER = '0x6b33ee9e'; // keeper == merchant == authorized charger
const MID = '0xmandate';
const ACC = '0xacc1';
const SIG: IsubSigner = { address: KEEPER, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };

let checks = 0;
const check = (c: boolean, label: string): void => { if (!c) throw new Error('✗ ' + label); checks++; console.log('  ✓ ' + label); };
async function expectAbort(fn: () => Promise<unknown>, code: number, label: string): Promise<void> {
  try { await fn(); check(false, label + ' (expected abort ' + code + ', none thrown)'); }
  catch (e) { check(e instanceof IsubAbortError && e.abortCode === code, label); }
}

function mkMandate(): MandateState {
  return {
    id: MID, accountId: ACC, subscriber: '0xsub', merchant: KEEPER, planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
    rateCap: 100n, rateWindowMs: 10_000_000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: KEEPER,
    spentTotal: 0n, totalBudget: 1_000n, expiryMs: 4_000_000_000_000n, chargeSeq: 0n, refundedTotal: 0n,
    maxPerCharge: 100n, notBeforeMs: 0n, status: MandateStatus.Active,
  };
}

/** Faithful mirror of `charge_metered` + `settle`: the seq idempotency gate and the on-chain caps. */
class MockChain implements BillerChain {
  m = mkMandate();
  acct: AccountState = { id: ACC, owner: '0xsub', balance: 1_000n };
  landed = 0;
  /** Simulate "the charge LANDS on-chain but the ack is lost" exactly once (a crash/timeout). */
  loseAckOnce = false;

  async getMandate(): Promise<MandateState> { return { ...this.m }; }
  async getAccount(): Promise<AccountState> { return { ...this.acct }; }

  async chargeMetered(_s: IsubSigner, p: { accountId: string; mandateId: string; amount: bigint; seq: bigint }): Promise<{ digest: string }> {
    if (p.seq !== this.m.chargeSeq) throw new IsubAbortError(E_BAD_SEQ);                        // idempotency gate
    if (this.m.windowSpent + p.amount > this.m.rateCap) throw new IsubAbortError(E_OVER_RATE_CAP);
    if (this.m.spentTotal + p.amount > this.m.totalBudget) throw new IsubAbortError(9);
    if (p.amount > this.m.maxPerCharge) throw new IsubAbortError(24);
    if (this.acct.balance < p.amount) throw new IsubAbortError(10);
    // settle(): apply state — the ONLY mutation path, exactly as the Move `settle` fn does.
    this.m.spentTotal += p.amount;
    this.m.windowSpent += p.amount;
    this.m.chargeSeq += 1n;
    this.acct.balance -= p.amount;
    const digest = 'd' + ++this.landed;
    if (this.loseAckOnce) { this.loseAckOnce = false; throw new Error('transient: charge landed, ack lost'); }
    return { digest };
  }
}

async function main(): Promise<void> {
  const chain = new MockChain();
  const store = memBillerStore();
  const biller = new IsubBiller(chain, SIG, store);

  // ── Act A — seq idempotency: a replayed (stale-seq) batch can NEVER double-charge ──
  await biller.recordUsage({ mandateId: MID, amount: 10n, usageId: 'u1' });
  await biller.flush(MID);
  check(chain.m.spentTotal === 10n && chain.m.chargeSeq === 1n, 'baseline charge landed (spent 10, seq 1)');
  await expectAbort(() => chain.chargeMetered(SIG, { accountId: ACC, mandateId: MID, amount: 10n, seq: 0n }), E_BAD_SEQ,
    'replay the landed batch at its OLD seq → EBadChargeSeq');
  check(chain.m.spentTotal === 10n, 'replay changed nothing on-chain (no double-charge)');

  // ── Act B — crash / lost-ack: charge landed but the keeper never saw the ack ──
  await biller.recordUsage({ mandateId: MID, amount: 10n, usageId: 'u2' });
  chain.loseAckOnce = true;
  await biller.flush(MID); // lands (spent 20, seq 2) but throws transient → next attempt's recoverOrphan repairs
  check(chain.m.spentTotal === 20n && chain.m.chargeSeq === 2n, 'lost-ack charge landed exactly once (spent 20, seq 2 — NOT 30)');
  check((await store.unbilled(MID)).length === 0, 'recoverOrphan marked the orphaned usage billed (no re-charge)');
  const clean = await reconcile(chain as unknown as Parameters<typeof reconcile>[0], store as unknown as Parameters<typeof reconcile>[1]);
  check(clean.ok === true, 'reconcile after recovery → zero drift (journal accounts for both charges)');

  // ── Act C — tamper boundary: cap BOUNDS an inflated amount; reconcile DETECTS an unjournaled charge ──
  await expectAbort(() => chain.chargeMetered(SIG, { accountId: ACC, mandateId: MID, amount: 9_999n, seq: 2n }), E_OVER_RATE_CAP,
    'inflate amount over the rate cap → EOverRateCap (cap can never be exceeded)');
  check(chain.m.spentTotal === 20n, 'over-cap attempt landed nothing (bounded by the on-chain cap)');

  // Inject a charge the journal never saw (a tampered inflation that landed, or an external trigger).
  await chain.chargeMetered(SIG, { accountId: ACC, mandateId: MID, amount: 5n, seq: 2n });
  check(chain.m.spentTotal === 25n && chain.m.chargeSeq === 3n, 'an unjournaled charge landed on-chain (within cap)');
  const drift = await reconcile(chain as unknown as Parameters<typeof reconcile>[0], store as unknown as Parameters<typeof reconcile>[1]);
  const row = drift.rows.find((r) => r.mandateId === MID)!;
  check(drift.ok === false && row.countDrift === 1 && row.unattributedAmount === 5n,
    'reconcile flags the drift — on-chain spend the journal can\'t itemize (detected, not prevented)');

  console.log(`\n✅ idempotency & tamper-boundary: ${checks} assertions — seq blocks replay, recoverOrphan survives crash, cap bounds inflation, reconcile detects the rest`);
}

main().catch((e) => { console.error('\n❌ idempotency smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });

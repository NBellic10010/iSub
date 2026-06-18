// Service-runtime smoke — headless (mock chain). Proves the WIRING logic the
// IsubService adds on top of the (already-tested) biller:
//   D1 credential validation (mandate must name THIS service, be PAYG, active),
//   D3 budget gate (refuse to serve beyond remaining budget) + threshold flush,
//   D2 event-driven stop (revoke detected via a failed charge → stop serving).
//
// Run: `npm run service:smoke`.
import { IsubService } from '../src/service';
import { memBillerStore, type BillerChain } from '../src/biller';
import { ChargeMode, MandateStatus } from '../src/constants';
import { IsubAbortError } from '../src/errors';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';

const SVC = '0x5e7711ce'; // this service's payout/merchant address
const OTHER = '0x0the700';
const SIG: IsubSigner = { address: SVC, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}

function mk(id: string, over: Partial<MandateState> = {}): MandateState {
  return {
    id, accountId: 'acc_' + id, subscriber: '0xsub', merchant: SVC, planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
    rateCap: 1_000n, rateWindowMs: 60_000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: SVC,
    spentTotal: 0n, totalBudget: 200n, expiryMs: 4_000_000_000_000n, chargeSeq: 0n, refundedTotal: 0n,
    maxPerCharge: 1_000n, notBeforeMs: 0n, status: MandateStatus.Active, ...over,
  };
}

class MockChain implements BillerChain {
  mandates = new Map<string, MandateState>();
  balances = new Map<string, bigint>();
  add(m: MandateState, balance = 10_000n): void {
    this.mandates.set(m.id, m);
    this.balances.set(m.accountId, balance);
  }
  async getMandate(id: string): Promise<MandateState> {
    const m = this.mandates.get(id);
    if (!m) throw new Error('no mandate ' + id);
    return { ...m };
  }
  async getAccount(id: string): Promise<AccountState> {
    return { id, owner: '0xowner', balance: this.balances.get(id) ?? 0n };
  }
  async chargeMetered(_s: IsubSigner, p: { accountId: string; mandateId: string; amount: bigint; seq: bigint }): Promise<{ digest: string }> {
    const m = this.mandates.get(p.mandateId)!;
    if (p.seq !== m.chargeSeq) throw new IsubAbortError(20);
    if (m.status !== MandateStatus.Active) throw new IsubAbortError(4);
    if (m.windowSpent + p.amount > m.rateCap) throw new IsubAbortError(8);
    if (p.amount > m.maxPerCharge) throw new IsubAbortError(24);
    if (m.spentTotal + p.amount > m.totalBudget) throw new IsubAbortError(9);
    if ((this.balances.get(m.accountId) ?? 0n) < p.amount) throw new IsubAbortError(10);
    m.windowSpent += p.amount;
    m.spentTotal += p.amount;
    m.chargeSeq += 1n;
    this.balances.set(m.accountId, (this.balances.get(m.accountId) ?? 0n) - p.amount);
    return { digest: 'd' + m.chargeSeq };
  }
}

async function main(): Promise<void> {
  // ===== A: credential validation (D1) =====
  console.log('• A: credential validation');
  const chain = new MockChain();
  chain.add(mk('M_ok'));
  chain.add(mk('M_other', { merchant: OTHER }));
  chain.add(mk('M_fixed', { mode: ChargeMode.Fixed }));
  chain.add(mk('M_revoked', { status: MandateStatus.Revoked }));
  const svc = new IsubService(chain, SIG, SVC, memBillerStore(), { windowMs: 999_999 });

  check((await svc.use('M_ok', 30n, 'a1')).status === 200, 'valid PAYG mandate for this service → 200');
  const other = await svc.use('M_other', 10n, 'a2');
  check(other.status === 403 && other.reason === 'mandate not for this service', 'mandate naming another merchant → 403');
  check((await svc.use('M_fixed', 10n, 'a3')).status === 403, 'Fixed-mode mandate → 403 (not PAYG)');
  check((await svc.use('M_revoked', 10n, 'a4')).status === 402, 'already-revoked mandate → 402 not active');

  // ===== B: budget gate (D3) =====
  console.log('\n• B: budget gate (serve only within remaining budget)');
  const chainB = new MockChain();
  chainB.add(mk('B', { totalBudget: 200n }));
  const svcB = new IsubService(chainB, SIG, SVC, memBillerStore(), { windowMs: 999_999 });
  let ok = 0;
  for (let i = 0; i < 6; i++) if ((await svcB.use('B', 30n, `b${i}`)).status === 200) ok++; // 180 used, 20 left
  check(ok === 6, 'served 6×30 within the 200 budget');
  const gated = await svcB.use('B', 30n, 'b6');
  check(gated.status === 402 && gated.reason === 'insufficient remaining budget for this request', 'request exceeding remaining budget → 402 (gated, no chain call)');
  check((await svcB.use('B', 20n, 'b7')).status === 200, 'a request that fits the last 20 → 200');

  // ===== C: threshold flush (D3) =====
  console.log('\n• C: threshold flush settles early');
  const chainC = new MockChain();
  chainC.add(mk('C', { totalBudget: 1_000n }));
  const svcC = new IsubService(chainC, SIG, SVC, memBillerStore(), { windowMs: 999_999, flushThresholdAmount: 50n });
  await svcC.use('C', 30n, 'c1');
  await svcC.use('C', 30n, 'c2'); // pending 60 ≥ 50 → triggers flush
  await svcC.flush('C'); // await the settle deterministically
  check((await chainC.getMandate('C')).spentTotal === 60n, 'crossing the threshold settled on-chain (spent=60)');

  // ===== D: event-driven stop on revoke (D2), bounded over-serve =====
  console.log('\n• D: revoke detected via failed charge → stop serving');
  const chainD = new MockChain();
  chainD.add(mk('D', { totalBudget: 1_000n }));
  const svcD = new IsubService(chainD, SIG, SVC, memBillerStore(), { windowMs: 999_999 });
  check((await svcD.use('D', 30n, 'd1')).status === 200, 'served while active');
  chainD.mandates.get('D')!.status = MandateStatus.Revoked; // subscriber revokes
  check((await svcD.use('D', 30n, 'd2')).status === 200, 'one more call served before the service learns of the revoke (bounded)');
  await svcD.flush('D'); // charge aborts #4 → biller emits charge.failed#4 → service marks not serviceable
  check((await chainD.getMandate('D')).spentTotal === 0n, 'revoked mandate: nothing charged (uncollectable, but never falsely charged)');
  const afterRevoke = await svcD.use('D', 30n, 'd3');
  check(afterRevoke.status === 402 && afterRevoke.reason === 'not_billable', 'service stops serving after detecting the revoke');

  console.log(`\n✅ service smoke passed — ${checks} assertions (credential · gate · threshold · revoke-stop)`);
}

main().catch((e) => {
  console.error('\n❌ service smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

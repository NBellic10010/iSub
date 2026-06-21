// x402 smoke — iSub's OWN x402 (mandate scheme) end-to-end: SELLER 402 → BUYER X-PAYMENT (PoP, no
// transfer tx) → FACILITATOR verify/settle → on-chain charge. Plus: bearer attacks are rejected
// THROUGH x402 (PoP enforced), and the metered path settles via the RateCard. Deterministic (MockChain,
// real Ed25519 keys, real agent-auth signatures). Run: npx tsx scripts/x402-smoke.ts
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubService } from '../src/service';
import { memBillerStore, type BillerChain } from '../src/biller';
import { issueAgentCert } from '../src/agent-auth';
import { buildPaymentRequirements, paymentRequired, createMandatePayment, MandateFacilitator, encodePayment, decodePayment, ISUB_SCHEME, type PaymentPayload } from '../src/x402';
import { ChargeMode, MandateStatus } from '../src/constants';
import { IsubAbortError } from '../src/errors';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';
import type { RateCard } from '../src/index';

const SVC = '0x5e7711ce'; // merchant/service payout address
const SIG: IsubSigner = { address: SVC, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };
const ASSET = '0x2::sui::SUI';
const NET = 'sui-testnet' as const;
const CARD: RateCard = { version: 1, meters: { call: { key: 'call', priceNum: 10n, priceDen: 1n, units: 1n } } };

let checks = 0;
const check = (c: boolean, label: string): void => { if (!c) throw new Error('✗ ' + label); checks++; console.log('  ✓ ' + label); };

function mk(id: string, subscriber: string): MandateState {
  return {
    id, accountId: 'acc_' + id, subscriber, merchant: SVC, planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
    rateCap: 1_000_000n, rateWindowMs: 60_000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: SVC,
    spentTotal: 0n, totalBudget: 1_000n, expiryMs: 4_000_000_000_000n, chargeSeq: 0n, refundedTotal: 0n,
    maxPerCharge: 1_000_000n, notBeforeMs: 0n, status: MandateStatus.Active,
  };
}

class MockChain implements BillerChain {
  mandates = new Map<string, MandateState>();
  add(m: MandateState): void { this.mandates.set(m.id, m); }
  async getMandate(id: string): Promise<MandateState> {
    const m = this.mandates.get(id);
    if (!m) throw new Error('no mandate ' + id);
    return { ...m };
  }
  async getAccount(id: string): Promise<AccountState> { return { id, owner: '0xowner', balance: 1_000_000n }; }
  async chargeMetered(_s: IsubSigner, p: { accountId: string; mandateId: string; amount: bigint; seq: bigint }): Promise<{ digest: string }> {
    const m = this.mandates.get(p.mandateId)!;
    if (p.seq !== m.chargeSeq) throw new IsubAbortError(20);
    if (m.spentTotal + p.amount > m.totalBudget) throw new IsubAbortError(9);
    m.spentTotal += p.amount;
    m.chargeSeq += 1n;
    return { digest: 'd' + m.chargeSeq };
  }
}

async function main(): Promise<void> {
  const subscriberKp = new Ed25519Keypair(); // owns the mandate (its address = on-chain subscriber)
  const agentKp = new Ed25519Keypair(); // the authorized agent key
  const attackerKp = new Ed25519Keypair(); // a key NOT authorized by the cert

  const chain = new MockChain();
  chain.add(mk('M1', subscriberKp.toSuiAddress()));
  chain.add(mk('M2', subscriberKp.toSuiAddress())); // never bound — for the clean bearer test

  // The merchant's runtime, with agent-auth ENFORCED (x402 path must present a PoP).
  const svc = new IsubService(chain, SIG, SVC, memBillerStore(), { windowMs: 999_999, agentAuth: 'enforce' }, undefined, CARD);
  const fac = new MandateFacilitator(svc, NET);

  // The subscriber authorizes the agent key once (off-chain cert).
  const cert = await issueAgentCert(subscriberKp, { mandateId: 'M1', agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 });

  // ===== A: SELLER builds the 402 challenge =====
  console.log('• A: SELLER — buildPaymentRequirements → 402');
  const reqs = buildPaymentRequirements({ amount: 30n, payTo: SVC, asset: ASSET, network: NET, resource: '/forecast' });
  const body402 = paymentRequired([reqs]);
  check(body402.x402Version === 2 && body402.accepts[0]!.scheme === ISUB_SCHEME, '402 advertises the `mandate` scheme (x402 v2)');
  check(body402.accepts[0]!.payTo === SVC && body402.accepts[0]!.maxAmountRequired === '30' && body402.accepts[0]!.asset === ASSET, '402 carries payTo / amount=30 / asset');

  // ===== B: BUYER turns the 402 into a signed X-PAYMENT (PoP, NOT a transfer tx) =====
  console.log('\n• B: BUYER — createMandatePayment → X-PAYMENT header');
  const pay = await createMandatePayment({ requirements: reqs, mandateId: 'M1', usageId: 'x1', agent: agentKp, cert });
  const header = encodePayment(pay);
  const decoded = decodePayment(header);
  check(decoded.scheme === ISUB_SCHEME && decoded.payload.mandateId === 'M1' && !!decoded.payload.sig && !!decoded.payload.cert, 'X-PAYMENT base64 round-trips; carries mandateId + PoP sig + cert (no signed transfer tx)');

  // ===== C: FACILITATOR verify + settle (legit) =====
  console.log('\n• C: FACILITATOR — /verify + /settle (legit)');
  const v = await fac.verify(decoded, reqs);
  check(v.isValid && v.payer === agentKp.toSuiAddress(), '/verify → valid, payer = the bound agent');
  const s = await fac.settle(decoded, reqs);
  check(s.success && s.settlement === 'provisional', '/settle → success (provisional, within caps)');
  await svc.flush('M1');
  check((await chain.getMandate('M1')).spentTotal === 30n, 'settled on-chain at flush → spent_total = 30');

  // ===== D: bearer attacks rejected THROUGH x402 =====
  console.log('\n• D: bearer / impersonation rejected through x402');
  const fresh = (BigInt(Date.now()) + 60_000n).toString();
  const bareBearer: PaymentPayload = { x402Version: 2, scheme: ISUB_SCHEME, network: NET, payload: { mandateId: 'M2', usageId: 'evil1', sig: '', notAfter: fresh, amount: '30' } };
  check(!(await fac.verify(bareBearer, reqs)).isValid, 'bare bearer (public mandateId only, no cert/sig) → /verify invalid');
  const sb = await fac.settle(bareBearer, reqs);
  check(!sb.success && sb.errorReason!.startsWith('403'), 'bare bearer → /settle 403 (PoP enforced)');

  const evil = await createMandatePayment({ requirements: reqs, mandateId: 'M1', usageId: 'evil2', agent: attackerKp, cert }); // attacker key + stolen victim cert
  check(!(await fac.verify(evil, reqs)).isValid, 'attacker-signed + stolen cert → /verify invalid (sig ≠ bound agent)');
  const se = await fac.settle(evil, reqs);
  check(!se.success && se.errorReason!.startsWith('403'), 'attacker-signed → /settle 403');
  await svc.flush('M1');
  check((await chain.getMandate('M1')).spentTotal === 30n, 'attacker calls never settled → spent_total still 30');

  // ===== E: metered path (RateCard prices the items) =====
  console.log('\n• E: METERED — useMetered through x402');
  const reqsM = buildPaymentRequirements({ amount: 10n, payTo: SVC, asset: ASSET, network: NET, resource: '/api', metered: true });
  const payM = await createMandatePayment({ requirements: reqsM, mandateId: 'M1', usageId: 'm1', agent: agentKp, cert, charge: { items: [{ meterKey: 'call', qty: 1n }] } });
  const sm = await fac.settle(decodePayment(encodePayment(payM)), reqsM);
  check(sm.success, '/settle (metered) → success (RateCard priced the items)');
  await svc.flush('M1');
  check((await chain.getMandate('M1')).spentTotal === 40n, 'metered call settled → 30 + 10 = 40');

  console.log(`\n✅ x402 smoke passed — ${checks} assertions (SELLER 402 · BUYER PoP X-PAYMENT · FACILITATOR verify/settle · bearer rejected · metered)`);
}

main().catch((e) => {
  console.error('\n❌ x402 smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

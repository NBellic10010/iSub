// Cortex agent-PoP END-TO-END (deterministic, no chain/network). Drives the REAL cortexServer() handler
// over a MockChain + real HTTP: a delegated AGENT presents a per-call proof-of-possession (issueAgentCert
// by the subscriber + signCall by the agent), the server enforces it, meters the call, and charges via
// the (mock) keeper. Proves the secure flow works end to end — and that a bearer call (no PoP) is 403.
// This is the reproducible proof for `npm run cortex-call` against `npm run cortex-serve`.
// Run: npm run cortex:e2e
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubService } from '../src/service';
import { memBillerStore, type BillerChain } from '../src/biller';
import { issueAgentCert, signCall, payloadOf } from '../src/agent-auth';
import { ChargeMode, MandateStatus } from '../src/constants';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';
import { cortexServer } from './cortex-serve';

const MERCHANT = '0x5e7711ce'; // == mandate.merchant == the service's payout
const PRICE = 1000n;
const sub = Ed25519Keypair.generate(); // the subscriber (signs the cert; == mandate.subscriber)
const agent = Ed25519Keypair.generate(); // the delegated agent key (signs each call's PoP)
const keeperSig: IsubSigner = { address: MERCHANT, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };

let checks = 0;
const check = (c: boolean, l: string): void => { if (!c) throw new Error('✗ ' + l); checks++; console.log('  ✓ ' + l); };

/** A faithful MockChain: charge_metered advances spent_total + charge_seq (so the response shows charged). */
class MockChain implements BillerChain {
  m: MandateState = {
    id: 'M1', accountId: 'accM1', subscriber: sub.toSuiAddress(), merchant: MERCHANT, planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n, rateCap: 1_000_000n, rateWindowMs: 3_600_000n,
    windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: MERCHANT, spentTotal: 0n, totalBudget: 1_000_000n,
    expiryMs: 4_000_000_000_000n, chargeSeq: 0n, refundedTotal: 0n, maxPerCharge: 1_000_000n, notBeforeMs: 0n, status: MandateStatus.Active,
  };
  async getMandate(): Promise<MandateState> { return { ...this.m }; }
  async getAccount(id: string): Promise<AccountState> { return { id, owner: sub.toSuiAddress(), balance: 1_000_000n }; }
  async chargeMetered(_s: IsubSigner, p: { amount: bigint; seq: bigint }): Promise<{ digest: string }> {
    if (p.seq !== this.m.chargeSeq) throw new Error('EBadChargeSeq');
    this.m.spentTotal += p.amount; this.m.windowSpent += p.amount; this.m.chargeSeq += 1n;
    return { digest: 'cortex-d' + this.m.chargeSeq };
  }
}

async function serverOn(authMode: 'off' | 'enforce'): Promise<{ url: string; close: () => void; chain: MockChain }> {
  const chain = new MockChain();
  const svc = new IsubService(chain, keeperSig, MERCHANT, memBillerStore(), { windowMs: 3_600_000, agentAuth: authMode });
  const server = cortexServer({ svc, getMandate: (id) => chain.getMandate(), authMode, services: { demo: PRICE } });
  const port = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));
  return { url: `http://127.0.0.1:${port}`, close: () => server.close(), chain };
}

async function post(url: string, body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const r = await fetch(`${url}/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}

/** Build a real per-call PoP the way cortex-call will: subscriber-signed cert + agent-signed call proof. */
async function pop(mandateId: string, usageId: string): Promise<Record<string, unknown>> {
  const cert = await issueAgentCert(sub, { mandateId, agent: agent.toSuiAddress(), notAfter: 0n, ver: 1 });
  const notAfter = BigInt(Date.now()) + 60_000n;
  const { sig } = await signCall(agent, { mandateId, usageId, merchant: MERCHANT, payload: payloadOf(undefined, PRICE), notAfter });
  return { agentSig: sig, agentSigNotAfter: Number(notAfter), agentCert: { agent: agent.toSuiAddress(), notAfter: '0', ver: 1, sig: cert.sig } };
}

async function main(): Promise<void> {
  console.log('• SECURE (enforce) cortex server — agent presents a per-call PoP');
  const enf = await serverOn('enforce');

  // HAPPY PATH: real PoP → served + charged on (mock) chain.
  const ok = await post(enf.url, { mandateId: 'M1', query: '2+2', usageId: 'u-1', ...(await pop('M1', 'u-1')) });
  check(ok.status === 200 && ok.data.result === 'analyzed input: 2+2', 'agent PoP call → 200 served');
  check(ok.data.charged === PRICE.toString() && ok.data.settled === true, `charged exactly ${PRICE} on-chain (digest ${ok.data.digest})`);
  check(enf.chain.m.spentTotal === PRICE, 'mandate spent advanced by exactly one charge');

  // BEARER: same call, NO PoP → 403 (the 5th-door hole, now closed).
  const bearer = await post(enf.url, { mandateId: 'M1', query: '2+2', usageId: 'u-2' });
  check(bearer.status === 403, 'bearer (no PoP) → 403 (theft-of-service blocked)');
  check(enf.chain.m.spentTotal === PRICE, 'bearer attempt charged nothing (still one charge total)');

  // REPLAY: reuse the first call's usageId + PoP → 409 (single-use), no extra charge.
  const replay = await post(enf.url, { mandateId: 'M1', query: '2+2', usageId: 'u-1', ...(await pop('M1', 'u-1')) });
  check(replay.status === 409 || replay.status === 403, `verbatim replay of usageId rejected (${replay.status})`);
  check(enf.chain.m.spentTotal === PRICE, 'replay charged nothing (still one charge total)');
  enf.close();

  // INSECURE opt-out: a server explicitly run with authMode 'off' serves a bearer call (the warned demo mode).
  console.log('\n• INSECURE (CORTEX_INSECURE_BEARER=1) — bearer served by explicit opt-out');
  const ins = await serverOn('off');
  const insBearer = await post(ins.url, { mandateId: 'M1', query: '2+2', usageId: 'i-1' });
  check(insBearer.status === 200 && insBearer.data.charged === PRICE.toString(), 'authMode off: bearer → 200 served (explicit, warned opt-out)');
  ins.close();

  console.log(`\n✅ cortex agent-PoP e2e — ${checks} assertions. Real cortexServer handler + real PoP (cert+signCall): secure path served & charged, bearer 403, replay rejected, opt-out works.`);
  process.exit(0);
}

main().catch((e) => { console.error('\n❌ cortex e2e failed:', e instanceof Error ? e.message : e); process.exit(1); });

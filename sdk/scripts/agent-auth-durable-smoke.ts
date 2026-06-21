// F5 — DURABLE agent-cert rollback protection. The in-memory session can prove rollback rejection
// within one process; this proves it SURVIVES a restart / holds across a SECOND service instance:
// a fresh IsubService over the SAME sqlBillerStore rejects a rolled-back (lower-ver) cert it never
// saw in-session, because the highest accepted ver is persisted (agent_cert_vers table).
//
// Scenario: subscriber rotates agent key A_old(ver1) → A_new(ver2). Once ver2 is used, a LEAKED
// A_old(ver1) cert must be rejected — even by an instance that booted after the rotation.
// Run: NODE_OPTIONS=--experimental-sqlite npx tsx scripts/agent-auth-durable-smoke.ts
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubService } from '../src/service';
import { openDb } from '../src/db';
import { sqlBillerStore } from '../src/sql-store';
import { issueAgentCert, signCall, payloadOf, type AgentCert, type CallProof } from '../src/agent-auth';
import { ChargeMode, MandateStatus } from '../src/constants';
import type { BillerChain } from '../src/biller';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';

const SVC = '0x5e7711ce';
const SIG: IsubSigner = { address: SVC, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };

let checks = 0;
const check = (c: boolean, label: string): void => { if (!c) throw new Error('✗ ' + label); checks++; console.log('  ✓ ' + label); };

function mk(id: string, subscriber: string): MandateState {
  return {
    id, accountId: 'acc_' + id, subscriber, merchant: SVC, planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
    rateCap: 1_000_000n, rateWindowMs: 3_600_000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: SVC,
    spentTotal: 0n, totalBudget: 1_000_000n, expiryMs: 4_000_000_000_000n, chargeSeq: 0n, refundedTotal: 0n,
    maxPerCharge: 1_000_000n, notBeforeMs: 0n, status: MandateStatus.Active,
  };
}
class MockChain implements BillerChain {
  constructor(private readonly m: MandateState) {}
  async getMandate(id: string): Promise<MandateState> { if (id !== this.m.id) throw new Error('no ' + id); return { ...this.m }; }
  async getAccount(id: string): Promise<AccountState> { return { id, owner: '0xo', balance: 10_000_000n }; }
  async chargeMetered(): Promise<{ digest: string }> { return { digest: 'd' }; }
}

async function proof(agent: Ed25519Keypair, cert: AgentCert, usageId: string): Promise<CallProof> {
  const notAfter = BigInt(Date.now()) + 60_000n;
  const { sig } = await signCall(agent, { mandateId: 'M1', usageId, merchant: SVC, payload: payloadOf(undefined, 100n), notAfter });
  return { sig, notAfter, cert };
}

async function main(): Promise<void> {
  const subKp = new Ed25519Keypair();
  const aOld = new Ed25519Keypair(); // rotated-out (ver 1)
  const aNew = new Ed25519Keypair(); // current (ver 2)
  const mandate = mk('M1', subKp.toSuiAddress());
  const chain = new MockChain(mandate);

  // One DURABLE store shared by both "instances" (= the same DB a restart would reopen).
  const db = openDb(':memory:');
  const store = sqlBillerStore(db, 'merchantA');

  const certOld = await issueAgentCert(subKp, { mandateId: 'M1', agent: aOld.toSuiAddress(), notAfter: 0n, ver: 1 });
  const certNew = await issueAgentCert(subKp, { mandateId: 'M1', agent: aNew.toSuiAddress(), notAfter: 0n, ver: 2 });

  console.log('• instance #1 — subscriber has rotated to the ver=2 key; a ver=2 call is served');
  const svc1 = new IsubService(chain, SIG, SVC, store, { windowMs: 3_600_000, agentAuth: 'enforce' });
  check((await svc1.use('M1', 100n, 'd1', await proof(aNew, certNew, 'd1'), 'enforce')).status === 200, 'instance#1: ver=2 cert + valid PoP → 200 (persists durable ver=2)');
  // sanity: the rolled-back key would already be rejected on the SAME instance (session floor)
  check((await svc1.use('M1', 100n, 'd2', await proof(aOld, certOld, 'd2'), 'enforce')).status === 403, 'instance#1: rolled-back ver=1 cert → 403 (session floor)');

  console.log('\n• instance #2 — a FRESH service over the SAME store (simulates restart / 2nd node)');
  const svc2 = new IsubService(chain, SIG, SVC, store, { windowMs: 3_600_000, agentAuth: 'enforce' });
  // The crux: svc2's in-memory session NEVER saw ver=2 — only the durable store did.
  check((await svc2.use('M1', 100n, 'd3', await proof(aOld, certOld, 'd3'), 'enforce')).status === 403, 'instance#2: leaked ver=1 cert → 403 via DURABLE floor (the F5 fix — session alone could not)');
  check((await svc2.use('M1', 100n, 'd4', await proof(aNew, certNew, 'd4'), 'enforce')).status === 200, 'instance#2: current ver=2 cert → 200 (durable floor allows ≥ max)');

  // Independent confirmation that the floor was actually persisted.
  const persisted = await store.getMaxCertVer!('M1');
  check(persisted === 2, `durable agent_cert_vers floor persisted = 2 (got ${persisted})`);

  db.close();
  console.log(`\n✅ F5 durable rollback verified — ${checks} assertions. A leaked/rotated-out cert is rejected across instances/restarts, not just within one session.`);
}

main().catch((e) => { console.error('\n❌ agent-auth durable smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });

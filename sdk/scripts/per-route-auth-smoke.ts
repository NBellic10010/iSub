// Per-route agent-auth regression: ONE IsubService / ONE biller serves BOTH a human merchant-metered
// route (authMode 'off' → no proof needed → 200) AND an agent/x402 route (authMode 'enforce' → PoP
// required). Proves the per-route fix doesn't break human PAYG, that 'warn' is a safe migration step,
// that the trusted route (not the client) sets the mode, and that no second service/biller is created.
// Run: npx tsx scripts/per-route-auth-smoke.ts
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubService } from '../src/service';
import { memBillerStore, type BillerChain } from '../src/biller';
import { issueAgentCert, signCall, payloadOf, type AgentCert, type CallProof } from '../src/agent-auth';
import { MandateFacilitator, buildPaymentRequirements, createMandatePayment, decodePayment, encodePayment } from '../src/x402';
import { createIsubMcpServer } from '../src/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ChargeMode, MandateStatus } from '../src/constants';
import { IsubAbortError } from '../src/errors';
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
  m = new Map<string, MandateState>();
  add(x: MandateState): void { this.m.set(x.id, x); }
  async getMandate(id: string): Promise<MandateState> { const x = this.m.get(id); if (!x) throw new Error('no ' + id); return { ...x }; }
  async getAccount(id: string): Promise<AccountState> { return { id, owner: '0xo', balance: 10_000_000n }; }
  async chargeMetered(_s: IsubSigner, p: { accountId: string; mandateId: string; amount: bigint; seq: bigint }): Promise<{ digest: string }> {
    const x = this.m.get(p.mandateId)!;
    if (p.seq !== x.chargeSeq) throw new IsubAbortError(20);
    if (x.spentTotal + p.amount > x.totalBudget) throw new IsubAbortError(9);
    x.spentTotal += p.amount; x.chargeSeq += 1n; return { digest: 'd' + x.chargeSeq };
  }
}

async function validProof(agent: Ed25519Keypair, cert: AgentCert, mandateId: string, usageId: string, amount: bigint): Promise<CallProof> {
  const notAfter = BigInt(Date.now()) + 60_000n;
  const { sig } = await signCall(agent, { mandateId, usageId, merchant: SVC, payload: payloadOf(undefined, amount), notAfter });
  return { sig, notAfter, cert };
}

async function main(): Promise<void> {
  const subKp = new Ed25519Keypair();
  const agentKp = new Ed25519Keypair();

  // ===== 1: ONE service (default 'off') serves human + agent routes =====
  console.log('• 1: one IsubService/biller, default off — human (off) + agent (enforce)');
  const chain = new MockChain();
  chain.add(mk('M_human', subKp.toSuiAddress()));
  chain.add(mk('M_agent', subKp.toSuiAddress()));
  const svc = new IsubService(chain, SIG, SVC, memBillerStore(), { windowMs: 3_600_000, agentAuth: 'off' });
  const cert = await issueAgentCert(subKp, { mandateId: 'M_agent', agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 });

  // ① human merchant-metered: NO proof, NO authMode → 200
  check((await svc.use('M_human', 1000n, 'h1')).status === 200, '① human merchant-metered (no proof) → 200');
  // agent route enforce, no proof → 403
  check((await svc.use('M_agent', 1000n, 'a1', undefined, 'enforce')).status === 403, 'agent route enforce, no proof → 403 (bearer rejected)');
  // agent route enforce + valid proof → 200
  check((await svc.use('M_agent', 1000n, 'a2', await validProof(agentKp, cert, 'M_agent', 'a2', 1000n), 'enforce')).status === 200, 'agent route enforce + valid PoP → 200');
  // ② human still 200 after enabling enforce on the agent route (same service)
  check((await svc.use('M_human', 1000n, 'h2')).status === 200, '② human route still 200 while agent route enforces (one service)');

  // single biller: settle both, no double charge
  await svc.flush('M_human'); await svc.flush('M_agent');
  check((await chain.getMandate('M_human')).spentTotal === 2000n, 'single biller: M_human spent 2000 (h1+h2), no duplication');
  check((await chain.getMandate('M_agent')).spentTotal === 1000n, 'single biller: M_agent spent 1000 (only the valid a2)');

  // ===== 2: 'warn' default — human stays 200 (logged), agent route still enforced =====
  console.log('\n• 2: migration via warn — human 200 (logged), agent enforce still 403');
  const chain2 = new MockChain(); chain2.add(mk('M_human', subKp.toSuiAddress())); chain2.add(mk('M_agent', subKp.toSuiAddress()));
  const svcWarn = new IsubService(chain2, SIG, SVC, memBillerStore(), { windowMs: 3_600_000, agentAuth: 'warn' });
  check((await svcWarn.use('M_human', 1000n, 'w1')).status === 200, 'warn default: human (no proof) → 200 (logged, not 403)');
  check((await svcWarn.use('M_agent', 1000n, 'w2', undefined, 'enforce')).status === 403, 'warn default but agent route forces enforce → 403');

  // ===== 3: even if the service default flips to 'enforce', the merchant route is immune by passing 'off' =====
  console.log('\n• 3: enforce default — merchant route passes off explicitly');
  const chain3 = new MockChain(); chain3.add(mk('M_human', subKp.toSuiAddress()));
  const svcEnf = new IsubService(chain3, SIG, SVC, memBillerStore(), { windowMs: 3_600_000, agentAuth: 'enforce' });
  check((await svcEnf.use('M_human', 1000n, 'e1', undefined, 'off')).status === 200, 'enforce default + merchant route authMode=off → 200 (immune)');
  check((await svcEnf.use('M_human', 1000n, 'e2')).status === 403, 'enforce default + NO override → 403 (why merchant route must set off explicitly)');

  // ===== 4: x402 facilitator ALWAYS enforces; client has no authMode field to downgrade =====
  console.log('\n• 4: x402 facilitator hard-enforces (client cannot downgrade)');
  const chain4 = new MockChain(); chain4.add(mk('M_agent', subKp.toSuiAddress()));
  const svc4 = new IsubService(chain4, SIG, SVC, memBillerStore(), { windowMs: 3_600_000, agentAuth: 'off' }); // default OFF on purpose
  const fac = new MandateFacilitator(svc4, 'sui-localnet');
  const reqs = buildPaymentRequirements({ amount: 1000n, payTo: SVC, asset: '0x2::sui::SUI', network: 'sui-localnet', resource: '/r' });
  // bearer payload (no cert/sig) — even though the service default is 'off', the facilitator forces enforce
  const bearer = { x402Version: 2, scheme: 'mandate', network: 'sui-localnet' as const, payload: { mandateId: 'M_agent', usageId: 'evil', sig: '', notAfter: (BigInt(Date.now()) + 60_000n).toString(), amount: '1000' } };
  check(!(await fac.settle(bearer, reqs)).success, 'facilitator settle: bearer (no PoP) → rejected, despite service default off');
  // legit payload via the buyer → settles
  const pay = await createMandatePayment({ requirements: reqs, mandateId: 'M_agent', usageId: 'ok', agent: agentKp, cert: await issueAgentCert(subKp, { mandateId: 'M_agent', agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 }) });
  check((await fac.settle(decodePayment(encodePayment(pay)), reqs)).success, 'facilitator settle: valid PoP → success');

  // ===== 5: MCP metered route enforces per-route via meteredAuthMode (service default OFF) =====
  console.log('\n• 5: MCP metered route — meteredAuthMode enforce on an off-default service');
  const chain5 = new MockChain(); chain5.add(mk('M_agent', subKp.toSuiAddress()));
  const svc5 = new IsubService(chain5, SIG, SVC, memBillerStore(), { windowMs: 3_600_000, agentAuth: 'off' });
  const mcp = createIsubMcpServer({ name: 'isub-test', service: svc5, meteredAuthMode: 'enforce', metered: [{ name: 'query', description: 'demo paid query', price: 1000n, run: () => ({ ok: true }) }] });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcl = new Client({ name: 'pr-smoke', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([mcp.connect(st), mcl.connect(ct)]);
  const mcall = async (name: string, a: Record<string, unknown>): Promise<{ data: any; isError: boolean }> => { const r = (await mcl.callTool({ name, arguments: a })) as { content: { text: string }[]; isError?: boolean }; return { data: JSON.parse(r.content[0]?.text ?? '{}'), isError: !!r.isError }; };
  const noProof = await mcall('query', { mandateId: 'M_agent', usageId: 'q1' });
  check(noProof.isError && noProof.data.status === 403, 'MCP metered (meteredAuthMode enforce): no proof → 403 despite service default off');
  const certA = await issueAgentCert(subKp, { mandateId: 'M_agent', agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 });
  const na = BigInt(Date.now()) + 60_000n;
  const { sig } = await signCall(agentKp, { mandateId: 'M_agent', usageId: 'q2', merchant: SVC, payload: payloadOf(undefined, 1000n), notAfter: na });
  const okCall = await mcall('query', { mandateId: 'M_agent', usageId: 'q2', agentSig: sig, agentSigNotAfter: na.toString(), agentCert: { agent: agentKp.toSuiAddress(), notAfter: '0', ver: 1, sig: certA.sig } });
  check(!okCall.isError && okCall.data.result?.ok === true, 'MCP metered: valid PoP → served (route enforced, not from tool args)');
  await mcl.close(); await mcp.close();

  // ===== 6: SECURE BY DEFAULT — OMITTING meteredAuthMode resolves to 'enforce', NOT 'off' =====
  // §5 set meteredAuthMode:'enforce' explicitly; this pins that LEAVING IT UNSET still enforces, so a
  // forgetful operator can't ship the bearer-mandateId hole. Regression guard for the secure-by-default fix.
  console.log('\n• 6: MCP metered route — meteredAuthMode OMITTED ⇒ enforce by default');
  const chain6 = new MockChain(); chain6.add(mk('M_def', subKp.toSuiAddress()));
  const svc6 = new IsubService(chain6, SIG, SVC, memBillerStore(), { windowMs: 3_600_000, agentAuth: 'off' }); // service default off…
  const mcp6 = createIsubMcpServer({ name: 'isub-default', service: svc6, metered: [{ name: 'query', description: 'demo', price: 1000n, run: () => ({ ok: true }) }] }); // …meteredAuthMode OMITTED
  const [ct6, st6] = InMemoryTransport.createLinkedPair();
  const mcl6 = new Client({ name: 'pr-def', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([mcp6.connect(st6), mcl6.connect(ct6)]);
  const r6 = (await mcl6.callTool({ name: 'query', arguments: { mandateId: 'M_def', usageId: 'd1' } })) as { content: { text: string }[]; isError?: boolean };
  const d6 = JSON.parse(r6.content[0]?.text ?? '{}');
  check(!!r6.isError && d6.status === 403, 'MCP metered, meteredAuthMode OMITTED: bearer (no PoP) → 403 (secure by default, not off)');
  await mcl6.close(); await mcp6.close();

  console.log(`\n✅ per-route agent-auth verified — ${checks} assertions. Human PAYG safe; agent/x402 + MCP enforced; secure-by-default (omitted ⇒ enforce); one service/biller; route (not client) sets the mode.`);
}

main().catch((e) => { console.error('\n❌ per-route-auth smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });

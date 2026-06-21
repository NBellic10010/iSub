// Agent-auth red-team — a REAL MCP Client↔Server round-trip that exercises the proof-of-possession
// fix (Option a, `agent-auth.ts`). With `agentAuth: 'enforce'`:
//   • a legit agent (subscriber-signed cert + per-call signature) is SERVED,
//   • an ATTACKER who only knows the PUBLIC mandate id — no key, no signature — is REJECTED (403),
//   • replayed-on-a-new-usageId / expired / wrong-payload signatures are REJECTED (403),
//   • a VERBATIM replay (same usageId + sig, the exact-capture case) is REJECTED (409 single-use) —
//     theft-of-SERVICE closed (F1): a captured payload can't be re-served even though funds are safe.
// The attacker shares the merchant's runtime (so the binding is already cached) — proving the
// per-call signature, not just the binding, is load-bearing.
//
// Wiring mirrors mcp-smoke.ts (real protocol, MockChain, real IsubService). Run:
//   npm run agent-auth:redteam     # (or: npx tsx scripts/agent-auth-redteam.ts)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createIsubMcpServer } from '../src/mcp';
import { IsubService } from '../src/service';
import { memBillerStore, type BillerChain } from '../src/biller';
import { agentTools, type IsubAgent } from '../src/agent';
import { issueAgentCert, signCall, payloadOf, type AgentCert } from '../src/agent-auth';
import { ChargeMode, MandateStatus } from '../src/constants';
import { IsubAbortError } from '../src/errors';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';

const SVC = '0x5e7711ce'; // merchant/service payout address
const SIG: IsubSigner = { address: SVC, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };
const QUERY_PRICE = 30n;

// Victim's keys: the wallet that OWNS the mandate (subscriber) + the agent key it delegates to.
const subscriberKp = Ed25519Keypair.generate();
const agentKp = Ed25519Keypair.generate();

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}

function mk(id: string, over: Partial<MandateState> = {}): MandateState {
  return {
    id, accountId: 'acc_' + id, subscriber: subscriberKp.toSuiAddress(), merchant: SVC, planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
    rateCap: 100_000n, rateWindowMs: 60_000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: SVC,
    spentTotal: 0n, totalBudget: 1_000n, expiryMs: 4_000_000_000_000n, chargeSeq: 0n, refundedTotal: 0n,
    maxPerCharge: 100_000n, notBeforeMs: 0n, status: MandateStatus.Active, ...over,
  };
}

class MockChain implements BillerChain {
  mandates = new Map<string, MandateState>();
  balances = new Map<string, bigint>();
  add(m: MandateState, balance = 1_000_000n): void {
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
    if (m.spentTotal + p.amount > m.totalBudget) throw new IsubAbortError(9);
    m.spentTotal += p.amount;
    m.chargeSeq += 1n;
    return { digest: 'd' + m.chargeSeq };
  }
}

async function connectClient(name: string, svc: IsubService, walletTools: ReturnType<typeof agentTools>) {
  const server = createIsubMcpServer({
    name: 'isub-demo', walletTools, service: svc,
    metered: [{
      name: 'query_price_feed', description: 'Get the latest price for a trading pair.', price: QUERY_PRICE,
      args: { pair: { type: 'string' } }, required: ['pair'],
      run: async (a) => ({ pair: a.pair, price: '1.2345', source: 'mock-feed' }),
    }],
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: '0.0.1' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { data: JSON.parse(r.content[0]?.text ?? '{}'), isError: !!r.isError };
  };
  return { server, client, call };
}

async function main(): Promise<void> {
  const chain = new MockChain();
  chain.add(mk('M1'));

  // The merchant runtime with proof-of-possession ENFORCED.
  const svc = new IsubService(chain, SIG, SVC, memBillerStore(), { windowMs: 999_999, agentAuth: 'enforce' });

  const fakeAgent = {
    listServices: () => [{ name: 'price-feed', planId: '0xplan', mode: 'payg' as const, maxTotalBudget: 1_000n }],
    subscribe: async () => ({ ok: true, mandateId: 'M1', service: 'price-feed', mode: 'payg' as const, terms: 'approved' as const }),
    unsubscribe: async (id: string) => ({ ok: true, digest: 'rev_' + id }),
    budgetStatus: async () => ({ balance: 0n, totalAuthorized: 0n, atRisk: 0n, overAuthorized: false, subscriptions: [] }),
  };
  const walletTools = agentTools(fakeAgent as unknown as IsubAgent);
  const victim = await connectClient('victim-agent', svc, walletTools);
  const attacker = await connectClient('attacker', svc, walletTools);

  // The subscriber (mandate owner) authorizes the agent key ONCE — a self-verifying cert.
  const cert: AgentCert = await issueAgentCert(subscriberKp, { mandateId: 'M1', agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 });
  const certArg = { agent: cert.agent, notAfter: cert.notAfter.toString(), ver: cert.ver, sig: cert.sig };
  const now = (): bigint => BigInt(Date.now());

  // Build MCP args for a per-call signed request (u64s cross the wire as numbers/strings, no bigint).
  async function signed(usageId: string, opts: { cert?: boolean; notAfter?: bigint; payloadAmount?: bigint } = {}): Promise<Record<string, unknown>> {
    const notAfter = opts.notAfter ?? now() + 60_000n;
    const payload = payloadOf(undefined, opts.payloadAmount ?? QUERY_PRICE);
    const { sig } = await signCall(agentKp, { mandateId: 'M1', usageId, merchant: SVC, payload, notAfter });
    const args: Record<string, unknown> = { mandateId: 'M1', pair: 'SUI/USDC', usageId, agentSig: sig, agentSigNotAfter: Number(notAfter) };
    if (opts.cert !== false) args.agentCert = certArg;
    return args;
  }

  console.log('• LEGIT agent — subscriber-signed cert + per-call signature');
  const v1args = await signed('victim-1'); // capture the EXACT payload the victim sends (verbatim-replay test below)
  const v1 = await victim.call('query_price_feed', v1args); // first call carries the cert
  check(!v1.isError && v1.data.result?.pair === 'SUI/USDC', 'legit signed call SERVED (cert + per-call sig)');
  const v2 = await victim.call('query_price_feed', await signed('victim-2', { cert: false })); // cert cached now
  check(!v2.isError && v2.data.result, 'second signed call SERVED without re-sending cert (session-cached binding)');

  console.log('\n• ATTACKER — only the PUBLIC mandate id, no key, no signature');
  const bearer = await attacker.call('query_price_feed', { mandateId: 'M1', pair: 'SUI/USDC', usageId: 'attacker-bearer' });

  console.log('\n• ATTACKER — replays the victim’s captured signature on a NEW usageId');
  const replay = await attacker.call('query_price_feed', { ...v1args, usageId: 'attacker-replay' });
  check(replay.isError && replay.data.status === 403, 'replayed signature on a new usageId → 403 (sig bound to the call)');

  console.log('\n• ATTACKER — replays the victim’s EXACT captured payload verbatim (same usageId + sig) [F1]');
  const verbatim = await attacker.call('query_price_feed', v1args); // byte-identical to the served victim-1 call
  check(verbatim.isError && verbatim.data.status === 409, 'verbatim replay (same usageId) → 409 single-use (theft-of-SERVICE closed)');

  console.log('\n• ATTACKER — expired signature, and wrong-payload signature');
  const expired = await victim.call('query_price_feed', await signed('victim-expired', { notAfter: now() - 1_000n }));
  check(expired.isError && expired.data.status === 403, 'expired (past not_after) signature → 403');
  const wrongPay = await victim.call('query_price_feed', await signed('victim-wrongpay', { payloadAmount: 99n }));
  check(wrongPay.isError && wrongPay.data.status === 403, 'signature over a different amount than charged → 403 (payload-bound)');

  console.log('\n• EXPIRED cert presented (fresh per-call sig) — must not (re)authorize');
  const expiredCert = await issueAgentCert(subscriberKp, { mandateId: 'M1', agent: agentKp.toSuiAddress(), notAfter: now() - 1_000n, ver: 1 });
  const notAfter = now() + 60_000n;
  const { sig: ecSig } = await signCall(agentKp, { mandateId: 'M1', usageId: 'victim-expcert', merchant: SVC, payload: payloadOf(undefined, QUERY_PRICE), notAfter });
  const expCertCall = await victim.call('query_price_feed', {
    mandateId: 'M1', pair: 'SUI/USDC', usageId: 'victim-expcert', agentSig: ecSig, agentSigNotAfter: Number(notAfter),
    agentCert: { agent: expiredCert.agent, notAfter: expiredCert.notAfter.toString(), ver: expiredCert.ver, sig: expiredCert.sig },
  });
  check(expCertCall.isError && expCertCall.data.status === 403, 'expired CERT presented → 403 (binding expiry enforced)');

  await svc.flush('M1');
  const spent = (await chain.getMandate('M1')).spentTotal;

  console.log('\n──────────── VERDICT ────────────');
  if (!bearer.isError && bearer.data.result) {
    console.log('❌ VULNERABLE — bearer mandateId still served an attacker.');
    throw new Error('✗ FIX REGRESSED: bearer call must be 403');
  }
  check(bearer.isError && bearer.data.status === 403, 'bearer mandateId (no proof) → 403 — theft-of-service CLOSED');
  console.log('✅ SECURED — only the agent holding the subscriber-authorized key is served.');
  check(spent === 60n, 'exactly 60 charged on-chain (2 legit victim calls × 30) — no attacker/negative call billed');
  console.log('─────────────────────────────────');

  await Promise.all([victim.client.close(), attacker.client.close(), victim.server.close(), attacker.server.close()]);
  console.log(`\n✅ agent-auth red-team passed — ${checks} assertions (legit served · bearer/replay/expired/wrong-payload all 403).`);
}

main().catch((e) => {
  console.error('\n❌ red-team failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

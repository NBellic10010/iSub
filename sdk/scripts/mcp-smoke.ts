// MCP smoke — the "组合 (订阅+计费)" scenario driven deterministically (no LLM), safe for CI.
//
// REAL parts: the @modelcontextprotocol/sdk Client↔Server handshake over InMemoryTransport
// (real protocol, real tool discovery + dispatch), the `agentTools()` wallet descriptors, and
// the REAL `IsubService` runtime (use → gate → meter → biller) — same `MockChain` the service
// smoke uses. MOCK part: the chain underneath (so it runs headless, with no funds). Real-chain
// proof is `mcp-e2e:testnet`.
//
// Flow an LLM agent would drive: subscribe → query×N (pay-per-call, agent never signs) →
// budget_status (watch it deplete) → unsubscribe. Plus the 402 budget gate, the 403 bad-credential
// gate (D1), an unknown-tool protocol error, and the bigint-as-decimal-string boundary.
//
// Run: `npm run mcp:smoke`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIsubMcpServer } from '../src/mcp';
import { IsubService } from '../src/service';
import { memBillerStore, type BillerChain } from '../src/biller';
import { agentTools, type IsubAgent } from '../src/agent';
import { ChargeMode, MandateStatus } from '../src/constants';
import { IsubAbortError } from '../src/errors';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';

const SVC = '0x5e7711ce'; // this service's payout/merchant address
const OTHER = '0x0the700';
const SIG: IsubSigner = { address: SVC, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };
const QUERY_PRICE = 30n;

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

// Same mock the service smoke uses — a faithful subset of charge_metered's on-chain asserts.
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
  const chain = new MockChain();
  chain.add(mk('M1', { totalBudget: 200n })); // what `subscribe` hands the agent back
  chain.add(mk('M_other', { merchant: OTHER })); // names a DIFFERENT merchant → bad credential

  // REAL service runtime over the mock chain (window huge → settle only on explicit flush).
  const svc = new IsubService(chain, SIG, SVC, memBillerStore(), { windowMs: 999_999 });

  // WALLET face: a minimal agent stand-in (its on-chain authorize/revoke is faked — the canned
  // mandate id is one the chain knows) run through the REAL `agentTools()` descriptors. budget_status
  // reads the real (mock-)chain mandate, so it reflects charges that have actually settled.
  const fakeAgent = {
    listServices: () => [{ name: 'price-feed', planId: '0xplan', mode: 'payg' as const, maxTotalBudget: 200n }],
    subscribe: async (_a: { service: string; budget: bigint; ttlMs?: number }) =>
      ({ ok: true, mandateId: 'M1', service: 'price-feed', mode: 'payg' as const, terms: 'approved' as const }),
    unsubscribe: async (id: string) => ({ ok: true, digest: 'rev_' + id }),
    budgetStatus: async () => {
      const m = await chain.getMandate('M1');
      const remaining = m.totalBudget - m.spentTotal;
      return {
        balance: 10_000n, totalAuthorized: m.totalBudget, atRisk: remaining, overAuthorized: false,
        subscriptions: [{ mandateId: 'M1', merchant: SVC, remaining }],
      };
    },
  };
  const walletTools = agentTools(fakeAgent as unknown as IsubAgent);

  // METERED face: a real paid per-call tool, settled through the service runtime.
  const server = createIsubMcpServer({
    name: 'isub-demo',
    walletTools,
    service: svc,
    // This smoke isolates the MCP protocol + billing mechanics; PoP enforcement (the SECURE DEFAULT
    // for metered tools) is covered by per-route-auth-smoke §5 + agent-auth-redteam. Opt out explicitly.
    meteredAuthMode: 'off',
    metered: [
      {
        name: 'query_price_feed',
        description: 'Get the latest price for a trading pair.',
        price: QUERY_PRICE,
        args: { pair: { type: 'string', description: 'e.g. SUI/USDC' } },
        required: ['pair'],
        run: async (a) => ({ pair: a.pair, price: '1.2345', source: 'mock-feed' }),
      },
    ],
  });

  // REAL MCP protocol over an in-process linked transport pair (no subprocess, deterministic).
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-smoke', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ data: any; isError: boolean }> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { data: JSON.parse(r.content[0]?.text ?? '{}'), isError: !!r.isError };
  };

  // ===== A: tool discovery over the real protocol =====
  console.log('• A: tool discovery (ListTools)');
  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  check(listed.tools.length === 5, 'server advertises 5 tools (4 wallet + 1 metered)');
  check(['budget_status', 'list_services', 'query_price_feed', 'subscribe', 'unsubscribe'].every((n) => names.includes(n)), 'both faces present: wallet verbs + query_price_feed');
  const qSchema = listed.tools.find((t) => t.name === 'query_price_feed')!.inputSchema as { required?: string[] };
  check(!!qSchema.required?.includes('mandateId') && !!qSchema.required?.includes('pair'), 'metered tool requires the mandateId credential + its business arg');

  // ===== B: wallet face — list + subscribe (bigint crosses as a decimal string) =====
  console.log('\n• B: wallet face (list_services, subscribe)');
  const svcs = await call('list_services');
  check(svcs.data[0].maxTotalBudget === '200' && typeof svcs.data[0].maxTotalBudget === 'string', 'list_services returns the cap as a decimal string (bigint-safe)');
  const sub = await call('subscribe', { service: 'price-feed', budget: '200' });
  check(sub.data.ok === true && sub.data.mandateId === 'M1', 'subscribe → ok, returns the mandate id (the payment credential)');

  // ===== C: metered face — pay-per-call (billing mechanics; PoP opted out here, enforced by default elsewhere) =====
  console.log('\n• C: metered face (query×6, each meters a charge)');
  let served = 0;
  for (let i = 0; i < 6; i++) {
    const r = await call('query_price_feed', { mandateId: 'M1', pair: 'SUI/USDC', usageId: `q${i}` });
    if (!r.isError && r.data.result?.pair === 'SUI/USDC' && r.data._payment?.charged === '30') served++;
  }
  check(served === 6, 'served 6 paid calls within the 200 budget (180 metered)');

  // ===== D: budget gate (402) — session-level, no chain call =====
  console.log('\n• D: budget gate + settled budget_status');
  const gated = await call('query_price_feed', { mandateId: 'M1', pair: 'SUI/USDC', usageId: 'q6' });
  check(gated.isError && gated.data.status === 402, '7th call (would exceed remaining 20) → 402 payment required, gated');

  await svc.flush('M1'); // settle the 6 served calls on-chain (mock) so budget_status reflects them
  const status = await call('budget_status');
  check(status.data.subscriptions[0].remaining === '20', 'budget_status reflects the 180 settled on-chain → 20 remaining (decimal string)');
  check((await chain.getMandate('M1')).spentTotal === 180n, 'exactly 180 charged on-chain (6×30) — never the gated 7th');

  // ===== E: bad credential (403) — D1 validation through MCP =====
  console.log('\n• E: credential validation (403)');
  const bad = await call('query_price_feed', { mandateId: 'M_other', pair: 'X', usageId: 'x0' });
  check(bad.isError && bad.data.status === 403, 'mandate naming another merchant → 403 (not a valid credential for this service)');

  // ===== F: unknown tool → protocol error (not an isError result) =====
  console.log('\n• F: unknown tool → JSON-RPC error');
  let threw = false;
  try { await client.callTool({ name: 'frobnicate', arguments: {} }); } catch { threw = true; }
  check(threw, 'calling an unregistered tool rejects at the protocol layer');

  // ===== G: unsubscribe =====
  console.log('\n• G: unsubscribe');
  const un = await call('unsubscribe', { mandateId: 'M1' });
  check(un.data.ok === true, 'unsubscribe → ok (terminal)');

  await client.close();
  await server.close();
  console.log(`\n✅ MCP smoke passed — ${checks} assertions (discovery · wallet · metered pay-per-call · gate · credential · protocol-error)`);
}

main().catch((e) => {
  console.error('\n❌ MCP smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

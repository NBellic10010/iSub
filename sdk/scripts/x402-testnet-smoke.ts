// Verifies the testnet x402 path with a REAL on-chain charge: an in-process MCP client drives the
// `pay` tool against the live seller, which settles via charge_metered on testnet and returns the
// real digest. Proves the Claude-CLI stage will settle for real. Costs a little testnet SUI.
// Run: npm run x402-testnet:smoke   (after npm run x402-testnet:setup)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIsubMcpServer } from '../src/mcp';
import { setupX402Testnet } from './x402-testnet-agent-setup';

let checks = 0;
const check = (c: boolean, label: string): void => { if (!c) throw new Error('✗ ' + label); checks++; console.log('  ✓ ' + label); };

async function main(): Promise<void> {
  const demo = await setupX402Testnet();
  console.log(`• mandate ${demo.mandateId}\n  suiscan ${demo.explorerMandate}`);
  const { url, server } = await demo.startSeller(0);
  const tools = demo.buildTools(url);
  const mcp = createIsubMcpServer({ name: 'isub-x402-testnet', walletTools: tools });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tn-smoke', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  const call = async (n: string, a: Record<string, unknown> = {}): Promise<{ data: any; isError: boolean }> => {
    const r = (await client.callTool({ name: n, arguments: a })) as { content: { text: string }[]; isError?: boolean };
    return { data: JSON.parse(r.content[0]?.text ?? '{}'), isError: !!r.isError };
  };

  const apis = await call('list_paid_apis');
  const tool = apis.data.find((a: any) => a.url.endsWith('/web_search'));
  check(!!tool, 'list_paid_apis → /web_search (Cortex MCP)');
  const before = await call('budget_status');
  console.log(`  budget before: ${before.data.spent} / ${before.data.budget}`);

  console.log('• pay /web_search (REAL on-chain charge_metered)…');
  const r = await call('pay', { url: tool.url });
  check(!r.isError && r.data.paid === true && r.data.status === 200, 'pay → 402 → on-chain settled → 200');
  check(!!r.data.settlement?.digest && r.data.settlement?.settlement === 'final', 'returned a REAL on-chain digest');
  console.log(`  digest:   ${r.data.settlement?.digest}`);
  console.log(`  explorer: ${r.data.settlement?.explorer}`);

  const after = await call('budget_status');
  check(BigInt(after.data.spent) > BigInt(before.data.spent), 'on-chain spent_total increased');
  console.log(`  budget after:  ${after.data.spent} / ${after.data.budget}`);

  await client.close();
  await mcp.close();
  server.close();
  console.log(`\n✅ testnet x402 verified — ${checks} assertions. Real charge on ${demo.explorerMandate}`);
  process.exit(0); // gRPC/sqlite handles can keep the loop alive; exit cleanly
}

main().catch((e) => { console.error('\n❌ testnet x402 smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });

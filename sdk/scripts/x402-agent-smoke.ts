// Verifies the MCP↔x402 stage end-to-end WITHOUT Claude: a real MCP Client↔Server (InMemoryTransport)
// drives the `pay` tool, which runs the full x402 round-trip (402 → X-PAYMENT PoP → settle) against the
// in-process paywalled seller, settling on the (mock) chain. Proves the stage is solid before you open
// Claude CLI. Run: npx tsx scripts/x402-agent-smoke.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIsubMcpServer } from '../src/mcp';
import { setupX402Demo } from './x402-agent-setup';

let checks = 0;
const check = (c: boolean, label: string): void => { if (!c) throw new Error('✗ ' + label); checks++; console.log('  ✓ ' + label); };

async function main(): Promise<void> {
  const demo = await setupX402Demo();
  const { url, server } = await demo.startSeller(0); // ephemeral port
  console.log(`• Cortex MCP seller on ${url} (endpoints: /web_search 1000, /code_interpreter 3000, /vision 5000)`);
  const tools = demo.buildTools(url);

  const mcp = createIsubMcpServer({ name: 'isub-x402', walletTools: tools });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'x402-agent-smoke', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([mcp.connect(serverT), client.connect(clientT)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ data: any; isError: boolean }> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { data: JSON.parse(r.content[0]?.text ?? '{}'), isError: !!r.isError };
  };

  console.log('\n• A: MCP tool discovery');
  const listed = await client.listTools();
  check(['pay', 'list_paid_apis', 'budget_status'].every((n) => listed.tools.some((t) => t.name === n)), 'server advertises pay / list_paid_apis / budget_status');

  console.log('\n• B: discover paid APIs');
  const apis = await call('list_paid_apis');
  const search = apis.data.find((a: any) => a.url.endsWith('/web_search'));
  const code = apis.data.find((a: any) => a.url.endsWith('/code_interpreter'));
  check(!!search && !!code, 'list_paid_apis returns /web_search and /code_interpreter with prices');

  console.log('\n• C: pay (the full x402 round-trip through the MCP pay tool)');
  const r1 = await call('pay', { url: search.url });
  check(!r1.isError && r1.data.paid === true && r1.data.status === 200, 'pay → 402 → auto-paid via mandate (PoP) → 200');
  check(r1.data.result?.source === 'cortex-web' && r1.data.charged === '1000', 'returned the web_search result; charged 1000');

  console.log('\n• D: budget moved on-chain');
  const b1 = await call('budget_status');
  check(b1.data.spent === '1000', 'budget_status: spent_total = 1000 (settled at flush)');

  const r2 = await call('pay', { url: code.url });
  check(!r2.isError && r2.data.paid === true && r2.data.result?.language === 'python' && r2.data.charged === '3000', 'pay /code_interpreter → paid 3000, got result');
  const b2 = await call('budget_status');
  check(b2.data.spent === '4000', 'spent_total now 4000 (1000 + 3000)');

  console.log('\n• E: paywall is real (unpaid direct fetch rejected)');
  const raw = await fetch(search.url);
  check(raw.status === 402, 'direct GET with no X-PAYMENT → 402 (PoP/payment enforced)');

  await client.close();
  await mcp.close();
  server.close();
  console.log(`\n✅ x402-agent stage verified — ${checks} assertions. Open it in Claude CLI with: npm run isub:claude`);
}

main().catch((e) => { console.error('\n❌ x402-agent smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });

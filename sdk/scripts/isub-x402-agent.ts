// The iSub x402 agent server — what Claude CLI (or any MCP client) connects to over stdio.
// Hosts the demo x402 seller (paywalled APIs) AND serves the MCP tools (list_paid_apis / pay /
// budget_status) so an agent can pay for those APIs from the iSub mandate via natural language.
//
// stdout is the MCP JSON-RPC channel — all logs go to stderr (via demo.log / console.error).
// Launch through Claude CLI with: npm run isub:claude   (see scripts/isub-claude.ts)
import { serveStdio } from '../src/mcp';
import { setupX402Demo } from './x402-agent-setup';

async function main(): Promise<void> {
  const demo = await setupX402Demo();
  const port = Number(process.env.ISUB_X402_PORT ?? 4021);
  const { url } = await demo.startSeller(port);
  demo.log(`demo x402 seller on ${url}  (paid endpoints: /weather, /premium-quote)`);
  demo.log(`mandate ${demo.mandateId} · agent ${demo.agentAddress.slice(0, 12)}… · subscriber ${demo.subscriberAddress.slice(0, 12)}…`);
  await serveStdio({ name: 'isub-x402', version: '0.0.1', walletTools: demo.buildTools(url) });
  demo.log('MCP server ready on stdio — tools: list_paid_apis · pay · budget_status');
}

main().catch((e) => { console.error('[isub-x402] fatal:', e instanceof Error ? e.message : e); process.exit(1); });

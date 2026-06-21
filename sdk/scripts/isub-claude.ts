// Launch Claude CLI with the iSub x402 agent wired in as an MCP server (mirrors `tpay claude`).
// Then just talk to Claude: "what paid APIs are there?" → "pay for the weather one" → "what have I spent?"
// Claude calls list_paid_apis / pay / budget_status; the `pay` tool runs the full x402 round-trip and
// settles from the iSub mandate. Forwards any extra flags to claude. Run: npm run isub:claude
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Two demo personas, selected by env:
//   default / ISUB_X402_TESTNET=1 — the x402 PAYG agent (list_paid_apis / pay / budget_status)
//   ISUB_TOKEN_AGENT=1            — the wallet/subscribe agent for a FIXED token package
//                                   (list_services / subscribe / budget_status / unsubscribe)
const tokenMode = process.env.ISUB_TOKEN_AGENT === '1';
const testnet = process.env.ISUB_X402_TESTNET === '1';
const serverScript = join(here, tokenMode ? 'isub-token-agent.ts' : 'isub-x402-agent.ts');

// Pass the MCP server the env it needs explicitly via mcp-config (independent of how Claude propagates env).
const env = tokenMode
  ? { ISUB_TOKEN_AGENT: '1', ISUB_NETWORK: process.env.ISUB_NETWORK ?? 'testnet' }
  : testnet
    ? { ISUB_X402_TESTNET: '1', NODE_OPTIONS: '--experimental-sqlite', ISUB_NETWORK: process.env.ISUB_NETWORK ?? 'testnet' }
    : undefined;
const mcpConfig = JSON.stringify({
  mcpServers: { isub: { command: 'npx', args: ['tsx', serverScript], ...(env ? { env } : {}) } },
});
const ALLOWED = tokenMode
  ? 'mcp__isub__list_services,mcp__isub__subscribe,mcp__isub__budget_status,mcp__isub__unsubscribe'
  : 'mcp__isub__list_paid_apis,mcp__isub__pay,mcp__isub__budget_status';

const args = ['--mcp-config', mcpConfig, '--allowedTools', ALLOWED, ...process.argv.slice(2)];

const child = spawn('claude', args, { stdio: 'inherit' });
child.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'ENOENT') {
    console.error('claude CLI not found on PATH. Install Claude Code, then re-run — or register this MCP config in any MCP client:\n');
    console.error(JSON.stringify({ mcpServers: { isub: { command: 'npx', args: ['tsx', serverScript] } } }, null, 2));
  } else {
    console.error(e);
  }
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));

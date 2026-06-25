# MCP server

`@isubpay/sdk/mcp` exposes iSub to LLMs as **Model Context Protocol** tools, so an agent can check status, subscribe within policy, and pay per call — autonomously, but bounded by a human-set allow-list and the on-chain mandate caps.

```typescript
import { createIsubMcpServer } from '@isubpay/sdk/mcp';
import { IsubAgent, agentTools } from '@isubpay/sdk/agent';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const agent = new IsubAgent(isub, sessionSigner, { accountId, allowed: [/* AllowedService[] */] });

const server = createIsubMcpServer({
  agentTools: agentTools(agent),   // wallet/subscription tools; omit for a metered-only server
});

await server.connect(new StdioServerTransport()); // Claude Desktop; or an HTTP transport for remote
```

## Options

```typescript
interface IsubMcpOptions {
  /** Wallet/subscription tools — pass agentTools(agent). Omit for a metered-only server. */
  agentTools?: AgentTool[];
  // metered-payment tools are always available
}
```

* With **`agentTools`**: the agent can subscribe and manage spend within its `AllowedService` policy.
* Without: a **metered-only** server exposes pay-per-use tools (pair with the [gateway](../guides/managed-gateway.md) for a402-style serving).

## Tools

The server implements the standard MCP `ListTools` / `CallTool` handlers. Tools cover:

* **status** — is a subscription serviceable / how much budget remains.
* **subscribe** — authorize a mandate for an allow-listed service, within `maxTotalBudget` / `maxPerCharge`.
* **meter / pay** — record and settle a unit of usage.

Every tool call is bounded twice: by the agent's policy (off-chain allow-list) and by the mandate's on-chain caps (`totalBudget`, `maxPerCharge`, `rateCap`, `expiryMs`).

## Transports

`createIsubMcpServer` returns a standard MCP `Server`; register it on any transport:

* `StdioServerTransport` — Claude Desktop and other local MCP hosts.
* An HTTP transport — remote/hosted agents.

## Safety model

* The session key the agent signs with is **budget-bounded** — its mandate caps total spend, per-charge size, and lifetime.
* A human can `revoke`/`withdraw` at any time to kill the agent's spend instantly.
* Every charge is an on-chain event — auditable after the fact.

See `sdk/scripts/mcp-smoke.ts` for a runnable server + `IsubAgent` and the [AI-agent payments guide](../guides/ai-agents-mcp.md).

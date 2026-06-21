# AI-agent payments (MCP)

iSub is built for the agent economy: an autonomous agent can **subscribe and pay per call within a human-set policy**, and an LLM can drive it through the Model Context Protocol (MCP).

The shape: a human funds an `Account` and defines an allow-list of services with hard caps; the agent holds a budget-bounded session key that may `subscribe` and trigger charges **only within that policy**.

## `IsubAgent`

```typescript
import { IsubAgent } from '@isub/sdk/agent';
import { ChargeMode } from '@isub/sdk';

const agent = new IsubAgent(isub, sessionSigner, {
  accountId,                            // the human-funded account the agent draws from
  allowed: [{
    name: 'gpu-api',
    planId: '0x…',
    merchant: merchant.address,
    mode: ChargeMode.Payg,
    rateCap: 100_000_000n,
    rateWindowMs: 60_000n,
    keeper: keeper.address,
    maxTotalBudget: 200_000_000n,       // the agent may authorize at most this much here
    maxPerCharge: 50_000_000n,
  }],
});

// the agent autonomously subscribes — one real on-chain mandate, within policy
const sub = await agent.subscribe({ service: 'gpu-api', budget: 200_000_000n, ttlMs: 30 * 86_400_000 });
// sub.ok, sub.mandateId
```

`subscribe` validates the request against the matching `AllowedService` (mode, plan, merchant/keeper, and the `maxTotalBudget` / `maxPerCharge` ceilings) before authorizing. An agent can't exceed what the human allow-listed, and the on-chain caps backstop it regardless.

## MCP server

Expose iSub to an LLM (Claude Desktop, etc.) as MCP tools:

```typescript
import { createIsubMcpServer } from '@isub/sdk/mcp';
import { agentTools } from '@isub/sdk/agent';

const server = createIsubMcpServer({
  // metered-payment tools, plus optional wallet/subscription tools backed by an agent:
  agentTools: agentTools(agent),
});

// register on any transport — StdioServerTransport for Claude Desktop, HTTP for remote
await server.connect(transport);
```

The server advertises tools (list/call) for checking status, subscribing within policy, and metering usage — so an agent can transact autonomously while the human's caps and the on-chain mandate bound every action.

## a402-style metered access

For agent-to-agent / HTTP-402 flows, pair the [managed gateway](managed-gateway.md): the serving agent calls `backend.use(mandateId, amount, usageId)` and gets **200 served / 402 gated**. The paying agent's mandate is the budget; the gateway settles on-chain. This is the iSub analogue of a "pay-per-request" rail for machine clients.

## Why this is safe

* The session key is **budget-bounded** — its mandate has a `totalBudget`, `maxPerCharge`, `rateCap`, and `expiryMs`. Compromise is capped, not catastrophic.
* The human can `revoke`/`withdraw` at any time, killing the agent's spend instantly.
* Every agent charge is an on-chain event — fully auditable after the fact.

See [`IsubAgent`](../reference/isub-client.md) usage in `sdk/scripts/agent-smoke.ts` and the MCP server in `sdk/scripts/mcp-smoke.ts`.

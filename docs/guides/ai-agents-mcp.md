# AI-agent payments (MCP)

iSub is built for the agent economy: an autonomous agent can **subscribe and pay per call within a human-set policy** — speaking **x402** on the wire and aligned with **AP2**'s mandate model — and an LLM can drive it through the Model Context Protocol (MCP).

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

## x402 & AP2

iSub ships its own **x402** implementation (`@isub/sdk/x402`, V2-wire-compatible) with a custom **`mandate` scheme**. x402's stock `exact` scheme signs a fresh on-chain transfer per call; iSub's `mandate` scheme instead pays from a **standing, capped, revocable on-chain Mandate**, settled through the idempotent biller — so a single HTTP 402 round-trip carries a **recurring / metered** charge, not a one-shot transfer.

Three faces — own types, no external dependency, interoperable by shape:

| Role | Call | Does |
| --- | --- | --- |
| Seller | `buildPaymentRequirements()` | emit the `402` challenge (scheme · network · payTo · asset · amount) |
| Buyer | `createMandatePayment()` | build the `X-PAYMENT` payload — an agent-auth proof-of-possession, no fresh tx |
| Facilitator | `MandateFacilitator.verify()` / `.settle()` | cheap off-chain verify, then the single on-chain `charge_metered` |

```typescript
import { buildPaymentRequirements, createMandatePayment, MandateFacilitator } from '@isub/sdk/x402';
```

**AP2 alignment.** Google's Agent Payments Protocol centers agentic commerce on signed **mandates with constraints**. iSub's `Mandate` *is* that object — a capped, revocable authorization — but enforced **on-chain**, not just attested. An AP2-style intent maps directly onto an iSub mandate, so the same authorization that backs a subscription backs an agent's x402 payments.

Run it:

```bash
cd sdk
npm run x402:smoke     # full 402 → X-PAYMENT (PoP) → settle round-trip
npm run isub:claude    # an MCP server hosting x402-paywalled APIs an agent pays for via natural language
```

For the simpler managed path, the [gateway](managed-gateway.md)'s thin client returns **200 served / 402 gated** on `backend.use(...)`, settling on-chain behind the api-key.

## Why this is safe

* The session key is **budget-bounded** — its mandate has a `totalBudget`, `maxPerCharge`, `rateCap`, and `expiryMs`. Compromise is capped, not catastrophic.
* The human can `revoke`/`withdraw` at any time, killing the agent's spend instantly.
* Every agent charge is an on-chain event — fully auditable after the fact.

See [`IsubAgent`](../reference/isub-client.md) usage in `sdk/scripts/agent-smoke.ts` and the MCP server in `sdk/scripts/mcp-smoke.ts`.

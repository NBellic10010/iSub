// `./mcp` — expose iSub to an LLM agent as MCP tools, in ONE server with two faces:
//
//   • WALLET face  — the agent manages its own budget-bounded subscriptions
//     (`list_services / subscribe / unsubscribe / budget_status`). These are exactly the
//     framework-agnostic `agentTools(agent)` descriptors, registered 1:1 as MCP tools.
//   • METERED face — a real per-call paid service (`query_*`). Every call meters usage
//     through `IsubService.use(mandateId, price, usageId)`: the charge is pulled on-chain
//     from the agent's pre-authorized mandate, and the agent NEVER signs the payment. This
//     is the iSub thesis ("service auto-settles, agent doesn't sign") expressed as an MCP tool.
//
// The agent closes the loop itself: call `subscribe` → get a `mandateId` back → pass it to
// `query_*` on every call → watch `budget_status` deplete → `unsubscribe`. The mandate id is
// the payment credential that flows as a tool argument.
//
// Chain-agnostic: depends only on the narrow `MeteredService` slice (which `IsubService`
// satisfies structurally) and the `AgentTool[]` from `agentTools()`. So the SAME server
// drives the deterministic CI test (mock chain, `InMemoryTransport`) and the live Claude
// Desktop demo (real testnet, stdio) — only what you inject underneath changes.
//
// Server-only (node:crypto + the MCP SDK). Import via `@isubpay/sdk/mcp`, not the core index.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { AgentTool } from './agent';
import { proofFromFields } from './agent-auth';
import type { CallProof } from './agent-auth';

/** The slice of `IsubService` a metered tool needs (IsubService satisfies this structurally). */
export interface MeteredService {
  use(mandateId: string, amount: bigint, usageId: string, proof?: CallProof, authMode?: 'off' | 'warn' | 'enforce'): Promise<{ ok: boolean; status: number; reason?: string }>;
}

/** A real, paid per-call service exposed as one MCP tool. `mandateId`/`usageId` args are added for you. */
export interface MeteredToolDef {
  name: string;
  description: string;
  /** Charged on every served call, in base units (e.g. MIST). */
  price: bigint;
  /** JSON-Schema `properties` for the tool's BUSINESS args (mandateId/usageId are injected). */
  args?: Record<string, unknown>;
  /** Which business args are required (mandateId is always required). */
  required?: string[];
  /** Produce the result once payment is metered + gated. Receives only the business args. */
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface IsubMcpOptions {
  /** Wallet/subscription tools — pass `agentTools(agent)`. Omit for a metered-only server. */
  walletTools?: AgentTool[];
  /** Per-call paid tools. Each charges `price` via `service` on every call. */
  metered?: MeteredToolDef[];
  /** Required when `metered` is non-empty — the runtime that settles the charges. */
  service?: MeteredService;
  /**
   * Per-ROUTE proof-of-possession policy for the metered tools ('off' | 'warn' | 'enforce'). MCP
   * metered tools are agent-facing, so this is SECURE BY DEFAULT: when omitted it resolves to
   * 'enforce' — every call must carry a valid agent PoP or it is rejected 403, closing the
   * bearer-mandateId hole. Set 'off' ONLY for a merchant self-metering its own already-authenticated
   * users (never to inherit a permissive service default). Set by the operator — never from tool args.
   */
  meteredAuthMode?: 'off' | 'warn' | 'enforce';
  name?: string;
  version?: string;
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: jsonl(data) }] });
const fail = (error: string, extra: Record<string, unknown> = {}): CallToolResult => ({
  content: [{ type: 'text', text: jsonl({ error, ...extra }) }],
  isError: true,
});
/** Stringify with bigints → decimal strings (defensive; tool handlers already stringify). */
const jsonl = (v: unknown): string => JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));

/** Inject the payment-credential + proof-of-possession args into a metered tool's business schema. */
function meteredSchema(def: MeteredToolDef): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      mandateId: { type: 'string', description: 'Your payment credential — the mandate id returned by `subscribe`.' },
      usageId: { type: 'string', description: 'Optional idempotency id for this call (auto-generated if omitted).' },
      agentSig: { type: 'string', description: 'Proof-of-possession: your agent key’s signature over this call (required when the service enforces agent auth).' },
      agentSigNotAfter: { type: 'number', description: 'Freshness deadline (ms epoch) bound into agentSig.' },
      agentCert: { type: 'object', description: 'Binding cert {agent,notAfter,ver,sig} the mandate subscriber signed; present at least on the first call.' },
      ...(def.args ?? {}),
    },
    required: ['mandateId', ...(def.required ?? [])],
    additionalProperties: false,
  };
}

/** Meter the call (gate on budget/credential/proof), then run the work only if payment is accepted. */
async function runMetered(def: MeteredToolDef, service: MeteredService, args: Record<string, unknown>, authMode?: 'off' | 'warn' | 'enforce'): Promise<CallToolResult> {
  const mandateId = typeof args.mandateId === 'string' ? args.mandateId : '';
  if (!mandateId) return fail('missing mandateId — call `subscribe` first, then pass the returned mandate id here');
  const usageId = typeof args.usageId === 'string' && args.usageId ? args.usageId : `u_${randomUUID()}`;

  // authMode is set by the operator (IsubMcpOptions.meteredAuthMode), NOT derived from tool args.
  const paid = await service.use(mandateId, def.price, usageId, proofFromFields(args), authMode);
  if (!paid.ok) {
    // 402 = out of budget / not serviceable (top up or stop); 403 = bad credential / missing agent proof.
    return fail(`payment required (HTTP ${paid.status}): ${paid.reason ?? 'not serviceable'}`, { status: paid.status, usageId });
  }
  // Strip credentials + proof so the business handler sees only its own args.
  const { mandateId: _m, usageId: _u, agentSig: _s, agentSigNotAfter: _n, agentCert: _c, ...businessArgs } = args;
  const result = await def.run(businessArgs);
  return ok({ result, _payment: { charged: def.price.toString(), usageId, mandateId } });
}

/**
 * Build the iSub MCP server. Register it on any transport: `StdioServerTransport` for Claude
 * Desktop, or `InMemoryTransport.createLinkedPair()` for a deterministic in-process test.
 */
export function createIsubMcpServer(opts: IsubMcpOptions): Server {
  const walletTools = opts.walletTools ?? [];
  const metered = opts.metered ?? [];
  if (metered.length > 0 && !opts.service) {
    throw new Error('createIsubMcpServer: `service` is required when `metered` tools are provided');
  }
  const service = opts.service;

  const server = new Server(
    { name: opts.name ?? 'isub', version: opts.version ?? '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...walletTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...metered.map((t) => ({
        name: t.name,
        description: `${t.description} Charges ${t.price} base units per call; pass your mandateId.`,
        inputSchema: meteredSchema(t),
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    const wallet = walletTools.find((t) => t.name === name);
    if (wallet) {
      try {
        return ok(await wallet.handler(args));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
    const m = metered.find((t) => t.name === name);
    if (m) {
      try {
        // Secure by default: agent-facing metered tools ENFORCE PoP unless the operator explicitly opts out.
        return await runMetered(m, service!, args, opts.meteredAuthMode ?? 'enforce');
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
    throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
  });

  return server;
}

/** Convenience for the Claude Desktop / CLI demo: build the server and connect it over stdio. */
export async function serveStdio(opts: IsubMcpOptions): Promise<Server> {
  const server = createIsubMcpServer(opts);
  await server.connect(new StdioServerTransport());
  return server;
}

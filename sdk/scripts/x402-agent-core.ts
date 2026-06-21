// Reusable x402 agent server: a paywalled HTTP seller (settled through an injected MandateFacilitator)
// + the MCP tools (list_paid_apis / pay / budget_status). Chain-agnostic — the caller injects the
// facilitator, the agent key+cert, and `confirm`/`getMandate` (mock or real testnet IsubClient). The
// testnet wiring (x402-testnet-agent-setup.ts) passes a `confirm` that flushes on-chain and returns
// the real charge_metered digest + suiscan link, surfaced back to the agent in the `pay` result.
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MandateFacilitator, buildPaymentRequirements, paymentRequired, decodePayment, payViaX402, type X402Network } from '../src/x402';
import type { AgentTool } from '../src/agent';
import type { MessageSigner, AgentCert } from '../src/agent-auth';

export interface PaidApi { path: string; price: bigint; label: string; run: () => unknown }

export interface AgentServerDeps {
  facilitator: MandateFacilitator;
  mandateId: string;
  agentKp: MessageSigner;
  cert: AgentCert;
  payoutAddress: string;
  asset: string;
  network: X402Network;
  apis: PaidApi[];
  log: (...a: unknown[]) => void;
  /** After facilitator.settle accrues, settle on-chain (flush) and return the proof. */
  confirm: (mandateId: string) => Promise<{ digest?: string; explorer?: string }>;
  getMandate: (mandateId: string) => Promise<{ spentTotal: bigint; totalBudget: bigint }>;
}

export interface AgentServer {
  startSeller: (port: number) => Promise<{ url: string; server: HttpServer }>;
  buildTools: (sellerBase: string) => AgentTool[];
}

export function buildAgentServer(d: AgentServerDeps): AgentServer {
  const reqsFor = (api: PaidApi) =>
    buildPaymentRequirements({ amount: api.price, payTo: d.payoutAddress, asset: d.asset, network: d.network, resource: api.path, description: api.label });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const api = d.apis.find((a) => a.path === path);
    if (!api) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' })); return; }
    const reqs = reqsFor(api);
    const xpay = req.headers['x-payment'];
    if (typeof xpay !== 'string' || !xpay) {
      d.log(`402 ${api.path} — challenge ${api.price} ${d.asset}`);
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify(paymentRequired([reqs])));
      return;
    }
    try {
      const payload = decodePayment(xpay);
      const v = await d.facilitator.verify(payload, reqs);
      if (!v.isValid) { res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify(paymentRequired([reqs], v.invalidReason))); return; }
      const s = await d.facilitator.settle(payload, reqs);
      if (!s.success) { res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify(paymentRequired([reqs], s.errorReason))); return; }
      const proof = await d.confirm(d.mandateId); // flush → on-chain charge_metered → digest
      const m = await d.getMandate(d.mandateId);
      const receipt = { settlement: proof.digest ? 'final' : 'provisional', digest: proof.digest ?? null, explorer: proof.explorer ?? null, spentTotal: m.spentTotal.toString(), budget: m.totalBudget.toString() };
      d.log(`200 ${api.path} — paid ${api.price}; spent ${m.spentTotal}/${m.totalBudget}${proof.digest ? ` · digest ${proof.digest}` : ''}`);
      res.writeHead(200, { 'content-type': 'application/json', 'x-payment-response': JSON.stringify(receipt) }).end(JSON.stringify(api.run()));
    } catch (e) {
      d.log(`500 ${api.path} — ${e instanceof Error ? e.message : String(e)}`);
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const startSeller = (port: number): Promise<{ url: string; server: HttpServer }> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => { void handle(req, res); });
      server.listen(port, () => {
        const a = server.address();
        const p = typeof a === 'object' && a ? a.port : port;
        resolve({ url: `http://localhost:${p}`, server });
      });
    });

  const buildTools = (sellerBase: string): AgentTool[] => {
    const apis = d.apis.map((a) => ({ url: sellerBase + a.path, price: a.price.toString(), asset: d.asset, label: a.label }));
    return [
      {
        name: 'list_paid_apis',
        description: 'List the available paid (x402) API endpoints payable from the iSub mandate. Call when the user asks what paid services/APIs are available.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => apis,
      },
      {
        name: 'pay',
        description:
          'Fetch a URL; if it responds HTTP 402 Payment Required (x402), automatically pay from the iSub mandate (on-chain, within its capped/revocable limits, agent-signed proof) and retry. Use whenever the user wants a paid API, a paywalled resource, or a metered service. Returns the upstream result + an on-chain settlement receipt (digest + explorer link).',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch (a paid x402 endpoint).' },
            method: { type: 'string', description: 'HTTP method (default GET).' },
            body: { type: 'string', description: 'Optional request body.' },
          },
          required: ['url'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const r = await payViaX402(fetch as never, String(args.url), {
            mandateId: d.mandateId,
            agent: d.agentKp,
            cert: d.cert,
            usageId: 'u_' + randomUUID(),
            method: typeof args.method === 'string' ? args.method : undefined,
            body: typeof args.body === 'string' ? args.body : undefined,
          });
          let result: unknown = r.body;
          try { result = JSON.parse(r.body); } catch { /* keep raw */ }
          let settlement: unknown;
          if (r.paymentResponse) { try { settlement = JSON.parse(r.paymentResponse); } catch { /* ignore */ } }
          return { status: r.status, paid: r.paid, charged: r.requirements?.maxAmountRequired, asset: r.requirements?.asset, result, settlement };
        },
      },
      {
        name: 'budget_status',
        description: 'Report the iSub mandate budget — amount spent on-chain and amount remaining. Call when the user asks about spend, budget, or remaining balance.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
          const m = await d.getMandate(d.mandateId);
          return { mandateId: d.mandateId, spent: m.spentTotal.toString(), budget: m.totalBudget.toString(), remaining: (m.totalBudget - m.spentTotal).toString(), asset: d.asset };
        },
      },
    ];
  };

  return { startSeller, buildTools };
}

// Shared wiring for the "Claude pays via x402" demo — used by both the in-process smoke
// (x402-agent-smoke.ts) and the stdio MCP server for Claude CLI (isub-x402-agent.ts).
//
// One process hosts BOTH sides so the demo is self-contained (no testnet funds needed):
//   • SELLER  — a tiny HTTP server with x402-paywalled endpoints, settled through the iSub
//               facilitator (MandateFacilitator → IsubService, agentAuth ENFORCED).
//   • BUYER   — an MCP `pay` tool that runs payViaX402: hit a URL → 402 → present X-PAYMENT
//               (PoP over the standing mandate) → retry → return the result.
// Chain is a MockChain (faithful subset of charge_metered) so it runs headless; swapping in the
// real IsubClient + a funded testnet mandate is the only change for an on-chain demo.
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubService } from '../src/service';
import { memBillerStore, type BillerChain } from '../src/biller';
import { issueAgentCert, type AgentCert } from '../src/agent-auth';
import { MandateFacilitator, buildPaymentRequirements, paymentRequired, decodePayment, payViaX402, ISUB_SCHEME, type X402Network } from '../src/x402';
import { ChargeMode, MandateStatus } from '../src/constants';
import { IsubAbortError } from '../src/errors';
import type { IsubSigner } from '../src/signer';
import type { AgentTool } from '../src/agent';
import type { MandateState, AccountState } from '../src/types';

const ASSET = '0xdemo::usdc::USDC'; // demo asset label (USDC stand-in)
const NET: X402Network = 'sui-localnet';
const MANDATE_ID = 'M_demo';

/** The demo's paywalled endpoints. */
const APIS: { path: string; price: bigint; label: string; run: () => unknown }[] = [
  { path: '/weather', price: 1_000n, label: 'Weather forecast (per call)', run: () => ({ location: 'Tokyo, JP', tempC: 26, forecast: 'humid & warm' }) },
  { path: '/premium-quote', price: 5_000n, label: 'Premium stock quote (per call)', run: () => ({ ticker: 'NVDA', price: 1234.5, source: 'demo-feed' }) },
];

function mk(id: string, subscriber: string, merchant: string): MandateState {
  return {
    id, accountId: 'acc_' + id, subscriber, merchant, planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
    rateCap: 1_000_000n, rateWindowMs: 3_600_000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: merchant,
    spentTotal: 0n, totalBudget: 100_000n, expiryMs: 4_000_000_000_000n, chargeSeq: 0n, refundedTotal: 0n,
    maxPerCharge: 1_000_000n, notBeforeMs: 0n, status: MandateStatus.Active,
  };
}

class MockChain implements BillerChain {
  mandates = new Map<string, MandateState>();
  add(m: MandateState): void { this.mandates.set(m.id, m); }
  async getMandate(id: string): Promise<MandateState> {
    const m = this.mandates.get(id);
    if (!m) throw new Error('no mandate ' + id);
    return { ...m };
  }
  async getAccount(id: string): Promise<AccountState> { return { id, owner: '0xowner', balance: 1_000_000n }; }
  async chargeMetered(_s: IsubSigner, p: { accountId: string; mandateId: string; amount: bigint; seq: bigint }): Promise<{ digest: string }> {
    const m = this.mandates.get(p.mandateId)!;
    if (p.seq !== m.chargeSeq) throw new IsubAbortError(20);
    if (m.spentTotal + p.amount > m.totalBudget) throw new IsubAbortError(9);
    m.spentTotal += p.amount;
    m.chargeSeq += 1n;
    return { digest: 'mock-d' + m.chargeSeq };
  }
}

export interface X402Demo {
  startSeller: (port: number) => Promise<{ url: string; server: HttpServer }>;
  buildTools: (sellerBase: string) => AgentTool[];
  mandateId: string;
  chain: MockChain;
  agentAddress: string;
  subscriberAddress: string;
  /** stdio-safe logging (stdout is the MCP JSON-RPC channel — log to stderr only). */
  log: (...a: unknown[]) => void;
}

export async function setupX402Demo(): Promise<X402Demo> {
  const subscriberKp = new Ed25519Keypair(); // owns the mandate (the human)
  const agentKp = new Ed25519Keypair();       // the authorized agent key (signs PoP per call)
  const merchantKp = new Ed25519Keypair();    // the service payout/keeper
  const merchantAddr = merchantKp.toSuiAddress();

  const chain = new MockChain();
  chain.add(mk(MANDATE_ID, subscriberKp.toSuiAddress(), merchantAddr));

  const signer: IsubSigner = { address: merchantAddr, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };
  const service = new IsubService(chain, signer, merchantAddr, memBillerStore(), { windowMs: 3_600_000, agentAuth: 'enforce' });
  const facilitator = new MandateFacilitator(service, NET);
  const cert: AgentCert = await issueAgentCert(subscriberKp, { mandateId: MANDATE_ID, agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 });

  const log = (...a: unknown[]): void => console.error('[isub-x402]', ...a);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const api = APIS.find((a) => a.path === path);
    if (!api) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' })); return; }
    const reqs = buildPaymentRequirements({ amount: api.price, payTo: merchantAddr, asset: ASSET, network: NET, resource: api.path, description: api.label });
    const xpay = req.headers['x-payment'];
    if (typeof xpay !== 'string' || !xpay) {
      log(`402 ${api.path} — challenge ${api.price} ${ASSET}`);
      res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify(paymentRequired([reqs])));
      return;
    }
    try {
      const payload = decodePayment(xpay);
      const v = await facilitator.verify(payload, reqs);
      if (!v.isValid) { res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify(paymentRequired([reqs], v.invalidReason))); return; }
      const s = await facilitator.settle(payload, reqs);
      if (!s.success) { res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify(paymentRequired([reqs], s.errorReason))); return; }
      await service.flush(MANDATE_ID); // settle the accrued charge on the (mock) chain so spend moves
      const spent = (await chain.getMandate(MANDATE_ID)).spentTotal;
      log(`200 ${api.path} — paid ${api.price}; spent_total now ${spent}/${100_000} (payer ${v.payer?.slice(0, 12)}…)`);
      res.writeHead(200, { 'content-type': 'application/json', 'x-payment-response': JSON.stringify({ settlement: s.settlement, amount: s.amount }) }).end(JSON.stringify(api.run()));
    } catch (e) {
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
    const apis = APIS.map((a) => ({ url: sellerBase + a.path, price: a.price.toString(), asset: ASSET, label: a.label }));
    return [
      {
        name: 'list_paid_apis',
        description: 'List the available paid (x402) API endpoints that can be paid for from the iSub mandate. Call this when the user asks what paid services or APIs are available.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => apis,
      },
      {
        name: 'pay',
        description:
          'Fetch a URL; if it responds HTTP 402 Payment Required (x402), automatically pay from the iSub mandate (within its on-chain caps, agent-signed proof-of-possession) and retry. Use this whenever the user wants to access a paid API, fetch something behind a paywall, or buy/use a metered resource. Returns the upstream result plus what was charged.',
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
            mandateId: MANDATE_ID,
            agent: agentKp,
            cert,
            usageId: 'u_' + randomUUID(),
            method: typeof args.method === 'string' ? args.method : undefined,
            body: typeof args.body === 'string' ? args.body : undefined,
          });
          let result: unknown = r.body;
          try { result = JSON.parse(r.body); } catch { /* keep raw */ }
          return { status: r.status, paid: r.paid, charged: r.requirements?.maxAmountRequired, asset: r.requirements?.asset, result };
        },
      },
      {
        name: 'budget_status',
        description: 'Report the iSub mandate budget — amount spent and amount remaining. Call when the user asks about spend, budget, or remaining balance.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => {
          const m = await chain.getMandate(MANDATE_ID);
          return { mandateId: MANDATE_ID, spent: m.spentTotal.toString(), budget: m.totalBudget.toString(), remaining: (m.totalBudget - m.spentTotal).toString(), asset: ASSET };
        },
      },
    ];
  };

  return { startSeller, buildTools, mandateId: MANDATE_ID, chain, agentAddress: agentKp.toSuiAddress(), subscriberAddress: subscriberKp.toSuiAddress(), log };
}

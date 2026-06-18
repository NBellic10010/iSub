// Example: a merchant API server billed by iSub (MANAGED mode).
//
// Your product is the /infer endpoint. iSub is a metering + billing sidecar you CALL —
// you run no keeper, no database, no chain client, and you never sign a charge. The whole
// integration is two touchpoints:
//   1) gate each billable request with `isub.use(...)`
//   2) react to billing lifecycle via a signed webhook
//
// Run (against a local or iSub-hosted gateway):
//   ISUB_BASE_URL=https://gateway.isub.dev ISUB_API_KEY=sk_live_xxx \
//   ISUB_WEBHOOK_SECRET=whsec_xxx PORT=3000 npx tsx examples/merchant/service.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { IsubServiceClient, verifyWebhook } from '@isub/sdk/client';

// ── config you get from iSub (api key + webhook secret) ──
const BASE_URL = process.env.ISUB_BASE_URL ?? 'http://127.0.0.1:8787';
const API_KEY = process.env.ISUB_API_KEY ?? 'sk_test_demo';
const WEBHOOK_SECRET = process.env.ISUB_WEBHOOK_SECRET ?? 'whsec_demo';
const PORT = Number(process.env.PORT ?? 3000);

const isub = new IsubServiceClient({ baseUrl: BASE_URL, apiKey: API_KEY });

// Your own business state. iSub webhooks drive it — no chain polling.
const suspended = new Set<string>();

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '';
  try {
    // ===== 1) your product, billed per call =====
    if (req.method === 'POST' && url === '/infer') {
      // the customer/agent presents its iSub mandate as the payment credential
      const mandateId = req.headers['x-isub-mandate'];
      if (typeof mandateId !== 'string') return json(res, 401, { error: 'missing x-isub-mandate' });
      if (suspended.has(mandateId)) return json(res, 402, { error: 'subscription suspended — top up or re-subscribe' });

      const body = JSON.parse((await readBody(req)) || '{}') as { tokens?: number; requestId?: string };
      const tokens = Number(body.tokens ?? 100);
      const cost = BigInt(tokens) * 1000n; // YOUR pricing: 1000 base units / token

      // usageId must be stable per logical request → a retry won't double-bill (idempotent).
      const usageId = body.requestId ?? `${mandateId}:${req.headers['x-request-id'] ?? cryptoId()}`;

      // THE ONE iSub CALL: meter this usage + gate on remaining budget.
      const r = await isub.use(mandateId, cost, usageId);
      if (r.status === 200) return json(res, 200, { result: `inference over ${tokens} tokens`, charged: cost.toString() });
      if (r.status === 402) return json(res, 402, { error: r.reason ?? 'out of budget' }); // gate: don't serve
      return json(res, 403, { error: r.reason ?? 'invalid payment credential' });
    }

    // ===== 2) iSub webhook receiver: react to billing lifecycle =====
    if (req.method === 'POST' && url === '/isub/webhook') {
      const raw = await readBody(req);
      const sig = req.headers['isub-signature'];
      if (typeof sig !== 'string' || !verifyWebhook({ secret: WEBHOOK_SECRET, body: raw, signatureHeader: sig })) {
        return json(res, 401, { error: 'bad signature' }); // reject forged/replayed events
      }
      const evt = JSON.parse(raw) as { type: string; data: { mandateId: string; amount?: string } };
      switch (evt.type) {
        case 'charge.succeeded':
          console.log(`paid ${evt.data.mandateId} +${evt.data.amount}`); // record revenue
          break;
        case 'budget.exhausted':
        case 'mandate.lapsed':
          suspended.add(evt.data.mandateId); // stop serving this customer
          console.log(`suspend ${evt.data.mandateId} (${evt.type})`);
          break;
        case 'mandate.recovered':
          suspended.delete(evt.data.mandateId); // they topped up → resume
          break;
      }
      return json(res, 200, { received: true });
    }

    if (url === '/health') return json(res, 200, { ok: true });
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => console.log(`merchant service on :${PORT}  →  iSub gateway ${BASE_URL}`));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}
function json(res: ServerResponse, status: number, obj: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}
function cryptoId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

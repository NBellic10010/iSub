// `IsubGateway` — the MANAGED multi-tenant front over `IsubService`. iSub runs ONE of
// these; a merchant integrates with just an api-key + the thin `@isub/sdk/client`,
// running NOTHING itself (no service / biller / DB / charge-signing).
//
// Why managed doesn't break non-custody: the gateway signs charges with iSub's keeper
// key, but that key has ZERO power over funds — `charge_metered` is chain-capped
// (rate/budget/per-charge/expiry) and pays the merchant's own `payoutAddress`. The
// gateway can only trigger charges the contract already permits, to the merchant.
// Trust is LIVENESS-only (we bill on time), never SAFETY. (Decisions D1–D7,
// managed-integration-plan.md.)
//
// Server-only (node:http + node:sqlite) — import `@isub/sdk/gateway`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Db } from './db';
import { merchantByApiKey, sqlBillerStore } from './sql-store';
import { IsubService, type ServicePolicy, type UseResult } from './service';
import type { BillerChain, BillerEvent } from './biller';
import type { IsubSigner } from './signer';
import { WebhookDispatcher, eventToWebhook } from './webhook';
import { IsubHttpError } from './errors';
import type { RateCard } from './pricing';

export interface MerchantRouting {
  /** Where this merchant's charges are paid — must equal `mandate.merchant` on accepted mandates. */
  payoutAddress: string;
  /** Optional signed-webhook delivery target for this merchant. */
  webhook?: { url: string; secret: string };
  /** Optional price list — enables raw-quantity metered reporting (`/usage-metered`) for this tenant. */
  rateCard?: RateCard;
}

export interface GatewayOptions {
  chain: BillerChain;
  /** iSub's keeper key — the `authorized_keeper` on every managed PAYG plan; signs all charges. */
  keeperSigner: IsubSigner;
  db: Db;
  policy: ServicePolicy;
  /** Resolve a tenant's payout + webhook config (operator-provided; e.g. from its own config/DB). */
  routing: (merchantId: string) => MerchantRouting | null;
}

export class IsubGateway {
  private readonly services = new Map<string, IsubService>(); // one per tenant, lazily started

  constructor(private readonly o: GatewayOptions) {}

  /** Lazily create + start a tenant's `IsubService` (tenant-scoped store, shared iSub keeper signer). */
  private serviceFor(merchantId: string): IsubService {
    const existing = this.services.get(merchantId);
    if (existing) return existing;
    const r = this.o.routing(merchantId);
    if (!r) throw new IsubHttpError(404, `no routing configured for merchant ${merchantId}`);
    const dispatcher = r.webhook ? new WebhookDispatcher({ endpoint: r.webhook.url, secret: r.webhook.secret }) : undefined;
    const svc = new IsubService(
      this.o.chain,
      this.o.keeperSigner,
      r.payoutAddress,
      sqlBillerStore(this.o.db, merchantId),
      this.o.policy,
      dispatcher ? (e: BillerEvent) => void dispatcher.enqueue(eventToWebhook(e)) : undefined,
      r.rateCard,
    );
    svc.start();
    this.services.set(merchantId, svc);
    return svc;
  }

  private auth(apiKey: string | undefined): string {
    if (!apiKey) throw new IsubHttpError(401, 'missing x-isub-api-key');
    const mid = merchantByApiKey(this.o.db, apiKey);
    if (!mid) throw new IsubHttpError(401, 'invalid api key');
    return mid;
  }

  // ===== in-process API (the thin client lands here; also handy for embedding/tests) =====

  /** Report a metered call against the agent's mandate (caller pre-priced the `amount`). */
  async use(apiKey: string | undefined, mandateId: string, amount: bigint, usageId: string): Promise<UseResult> {
    return this.serviceFor(this.auth(apiKey)).use(mandateId, amount, usageId);
  }
  /** Report RAW usage quantities; the tenant's RateCard prices them. Requires `routing.rateCard`. */
  async useMetered(
    apiKey: string | undefined,
    mandateId: string,
    items: ReadonlyArray<{ meterKey: string; qty: bigint }>,
    usageId: string,
  ): Promise<UseResult> {
    return this.serviceFor(this.auth(apiKey)).useMetered(mandateId, items, usageId);
  }
  status(apiKey: string | undefined, mandateId: string): ReturnType<IsubService['status']> {
    return this.serviceFor(this.auth(apiKey)).status(mandateId);
  }
  /** Settle now (test/manual; production settles on the window loop). */
  flush(apiKey: string | undefined, mandateId?: string): Promise<unknown> {
    return this.serviceFor(this.auth(apiKey)).flush(mandateId);
  }

  // ===== HTTP front =====

  listen(port: number): Server {
    const server = createServer((req, res) => void this.handle(req, res));
    server.listen(port);
    return server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true });
      const apiKey = headerOf(req, 'x-isub-api-key');

      // NOTE: must precede the '/usage' check below — '/usage-metered'.startsWith('/usage') is true.
      if (req.method === 'POST' && url.startsWith('/usage-metered')) {
        const mandateId = headerOf(req, 'x-isub-mandate');
        if (!mandateId) return json(res, 400, { ok: false, reason: 'missing x-isub-mandate header' });
        const body = await readBody(req);
        const { items, usageId } = JSON.parse(body || '{}') as { items?: { meterKey: string; qty: string }[]; usageId?: string };
        if (!Array.isArray(items) || usageId === undefined) return json(res, 400, { ok: false, reason: 'body needs { items: [{meterKey, qty}], usageId }' });
        const parsed = items.map((i) => ({ meterKey: String(i.meterKey), qty: BigInt(i.qty) }));
        const r = await this.useMetered(apiKey, mandateId, parsed, String(usageId));
        return json(res, r.status, r);
      }

      if (req.method === 'POST' && url.startsWith('/usage')) {
        const mandateId = headerOf(req, 'x-isub-mandate');
        if (!mandateId) return json(res, 400, { ok: false, reason: 'missing x-isub-mandate header' });
        const body = await readBody(req);
        const { amount, usageId } = JSON.parse(body || '{}') as { amount?: string; usageId?: string };
        if (amount === undefined || usageId === undefined) return json(res, 400, { ok: false, reason: 'body needs { amount, usageId }' });
        const r = await this.use(apiKey, mandateId, BigInt(amount), String(usageId));
        return json(res, r.status, r);
      }

      if (req.method === 'GET' && url.startsWith('/subscriptions/')) {
        const mandateId = (url.slice('/subscriptions/'.length).split('?')[0] ?? '').trim();
        const s = this.status(apiKey, mandateId);
        return json(res, s ? 200 : 404, s ?? { reason: 'unknown mandate' });
      }

      return json(res, 404, { reason: 'not found' });
    } catch (e) {
      if (e instanceof IsubHttpError) return json(res, e.status, { ok: false, reason: e.message });
      return json(res, 500, { ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Stop all tenants' flush loops + release locks. */
  async stop(): Promise<void> {
    for (const svc of this.services.values()) await svc.stop();
    this.services.clear();
  }
}

function headerOf(req: IncomingMessage, k: string): string | undefined {
  const v = req.headers[k];
  return typeof v === 'string' ? v : undefined;
}
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

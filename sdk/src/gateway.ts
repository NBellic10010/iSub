// `IsubGateway` — the MANAGED multi-tenant front over `IsubService`. iSub runs ONE of
// these; a merchant integrates with just an api-key + the thin `@isubpay/sdk/client`,
// running NOTHING itself (no service / biller / DB / charge-signing).
//
// Why managed doesn't break non-custody: the gateway signs charges with iSub's keeper
// key, but that key has ZERO power over funds — `charge_metered` is chain-capped
// (rate/budget/per-charge/expiry) and pays the merchant's own `payoutAddress`. The
// gateway can only trigger charges the contract already permits, to the merchant.
// Trust is LIVENESS-only (we bill on time), never SAFETY. (Decisions D1–D7,
// managed-integration-plan.md.)
//
// Server-only (node:http + node:sqlite) — import `@isubpay/sdk/gateway`.
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Db } from './db';
import { merchantByApiKey, sqlBillerStore, usageByMandate, chargesByMandate } from './sql-store';
import { buildComplianceReport, reportToCsv, monthRangeFromLabel, currentMonthUtc } from './compliance';
import { IsubService, type ServicePolicy, type UseResult } from './service';
import { proofFromFields, type CallProof } from './agent-auth';
import type { BillerChain, BillerEvent } from './biller';
import type { IsubSigner } from './signer';
import { WebhookDispatcher, eventToWebhook } from './webhook';
import { IsubHttpError } from './errors';
import type { RateCard } from './pricing';
import type { IsubIndex } from './relations';

export interface MerchantRouting {
  /** Where this merchant's charges are paid — must equal `mandate.merchant` on accepted mandates. */
  payoutAddress: string;
  /** Optional signed-webhook delivery target for this merchant. */
  webhook?: { url: string; secret: string };
  /** Optional price list — enables raw-quantity metered reporting (`/usage-metered`) for this tenant. */
  rateCard?: RateCard;
  /**
   * Per-tenant proof-of-possession policy ('off' | 'warn' | 'enforce'). The agent-facing HTTP door is
   * SECURE BY DEFAULT: when neither this nor the gateway-wide `policy.agentAuth` is set, it resolves to
   * 'enforce' — a bearer mandateId with no PoP is rejected 403. Set 'off' EXPLICITLY for a merchant
   * self-metering its own users (the api-key already authenticates them).
   * Lets ONE gateway serve human-off and agent-enforce tenants side by side, on one service each.
   */
  agentAuthMode?: 'off' | 'warn' | 'enforce';
}

export interface GatewayOptions {
  chain: BillerChain;
  /** iSub's keeper key — the `authorized_keeper` on every managed PAYG plan; signs all charges. */
  keeperSigner: IsubSigner;
  db: Db;
  policy: ServicePolicy;
  /** Resolve a tenant's payout + webhook config (operator-provided; e.g. from its own config/DB). */
  routing: (merchantId: string) => MerchantRouting | null;
  /**
   * Optional relationship index. When provided, the gateway serves the dashboard read API
   * (merchant→plans, subscriber→mandates, plan→mandates, owner→accounts) + write-time ingest
   * routes. Omit it and those routes 404 — billing is unaffected (the index is a read projection).
   */
  index?: IsubIndex;
  /**
   * Allowed browser origin for CORS (the wallet/subscriber dashboards call the public `/relations/*`
   * reads directly from the browser). Defaults to `*` for local dev / connect-test; in production set
   * this to your dashboard origin (e.g. `process.env.ISUB_CORS_ORIGIN`). CORS is a browser-only concern
   * — server-to-server callers (the thin client on a backend, curl) ignore it entirely.
   */
  corsOrigin?: string;
  /** Network label for the compliance report (`/report`) — sets its `network` field + the suiscan
   *  explorer base for per-charge audit links (e.g. 'testnet' | 'mainnet'). Omit → no explorer column. */
  network?: string;
  /** Fullnode base URL (the one that serves JSON-RPC — same as the gRPC base) + the iSub package id.
   *  Both enable on-chain mandate DISCOVERY for `/relations/mandates?subscriber=…&discover=1`, which
   *  scans `MandateAuthorized` events to complete the index for a subscriber. Omit either → the
   *  `discover` flag is ignored and the route serves a plain (possibly incomplete) index read. */
  rpcUrl?: string;
  packageId?: string;
  /** TLS key+cert (PEM). When set, `listen()` serves HTTPS — needed so an HTTPS browser dashboard can
   *  call it without a mixed-content block. Omit → plain HTTP (fine for curl / server-to-server). */
  tls?: { key: string | Buffer; cert: string | Buffer };
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
      // Secure by default: an agent-facing tenant ENFORCES PoP unless tenant or operator opts out.
      { ...this.o.policy, agentAuth: r.agentAuthMode ?? this.o.policy.agentAuth ?? 'enforce' },
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

  /** api-key → the authenticated merchant's on-chain address (its `payoutAddress`). */
  private merchantAddr(apiKey: string | undefined): string {
    const mid = this.auth(apiKey);
    const r = this.o.routing(mid);
    if (!r) throw new IsubHttpError(404, `no routing configured for merchant ${mid}`);
    return r.payoutAddress;
  }

  // ===== in-process API (the thin client lands here; also handy for embedding/tests) =====

  /** Report a metered call against the agent's mandate (caller pre-priced the `amount`). */
  async use(apiKey: string | undefined, mandateId: string, amount: bigint, usageId: string, proof?: CallProof): Promise<UseResult> {
    return this.serviceFor(this.auth(apiKey)).use(mandateId, amount, usageId, proof);
  }
  /** Report RAW usage quantities; the tenant's RateCard prices them. Requires `routing.rateCard`. */
  async useMetered(
    apiKey: string | undefined,
    mandateId: string,
    items: ReadonlyArray<{ meterKey: string; qty: bigint }>,
    usageId: string,
    proof?: CallProof,
  ): Promise<UseResult> {
    return this.serviceFor(this.auth(apiKey)).useMetered(mandateId, items, usageId, proof);
  }
  status(apiKey: string | undefined, mandateId: string): ReturnType<IsubService['status']> {
    return this.serviceFor(this.auth(apiKey)).status(mandateId);
  }
  /** Settle now (test/manual; production settles on the window loop). */
  flush(apiKey: string | undefined, mandateId?: string): Promise<unknown> {
    return this.serviceFor(this.auth(apiKey)).flush(mandateId);
  }

  // ===== HTTP front =====

  listen(port: number): HttpServer | HttpsServer {
    const handler = (req: IncomingMessage, res: ServerResponse): void => void this.handle(req, res);
    const server = this.o.tls ? createHttpsServer(this.o.tls, handler) : createHttpServer(handler);
    server.listen(port);
    return server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS: the browser dashboards call this cross-origin. Reads + the `/relations/*` ingest are
    // public (they only re-derive public on-chain data); api-key routes still require the key, now
    // just with CORS headers present so the preflight passes. Tighten the origin allow-list in prod.
    res.setHeader('access-control-allow-origin', this.o.corsOrigin ?? '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-isub-api-key, x-isub-mandate');
    res.setHeader('access-control-max-age', '86400');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    try {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true });
      const apiKey = headerOf(req, 'x-isub-api-key');

      // NOTE: must precede the '/usage' check below — '/usage-metered'.startsWith('/usage') is true.
      if (req.method === 'POST' && url.startsWith('/usage-metered')) {
        const mandateId = headerOf(req, 'x-isub-mandate');
        if (!mandateId) return json(res, 400, { ok: false, reason: 'missing x-isub-mandate header' });
        const body = await readBody(req);
        const parsedBody = JSON.parse(body || '{}') as { items?: { meterKey: string; qty: string }[]; usageId?: string; agentSig?: unknown; agentSigNotAfter?: unknown; agentCert?: unknown };
        const { items, usageId } = parsedBody;
        if (!Array.isArray(items) || usageId === undefined) return json(res, 400, { ok: false, reason: 'body needs { items: [{meterKey, qty}], usageId }' });
        const parsed = items.map((i) => ({ meterKey: String(i.meterKey), qty: BigInt(i.qty) }));
        const r = await this.useMetered(apiKey, mandateId, parsed, String(usageId), proofFromFields(parsedBody));
        return json(res, r.status, r);
      }

      if (req.method === 'POST' && url.startsWith('/usage')) {
        const mandateId = headerOf(req, 'x-isub-mandate');
        if (!mandateId) return json(res, 400, { ok: false, reason: 'missing x-isub-mandate header' });
        const body = await readBody(req);
        const parsedBody = JSON.parse(body || '{}') as { amount?: string; usageId?: string; agentSig?: unknown; agentSigNotAfter?: unknown; agentCert?: unknown };
        const { amount, usageId } = parsedBody;
        if (amount === undefined || usageId === undefined) return json(res, 400, { ok: false, reason: 'body needs { amount, usageId }' });
        const r = await this.use(apiKey, mandateId, BigInt(amount), String(usageId), proofFromFields(parsedBody));
        return json(res, r.status, r);
      }

      if (req.method === 'GET' && url.startsWith('/subscriptions/')) {
        const mandateId = (url.slice('/subscriptions/'.length).split('?')[0] ?? '').trim();
        const s = this.status(apiKey, mandateId);
        return json(res, s ? 200 : 404, s ?? { reason: 'unknown mandate' });
      }

      // ===== relationship index (dashboard read API) — only when an index is wired =====
      const index = this.o.index;
      if (index) {
        const { pathname, query } = parseUrl(url);

        // write-time ingest (api-key gated; re-derives the row from chain, so it's safe).
        if (req.method === 'POST' && pathname === '/index/plan') {
          this.auth(apiKey);
          const { planId } = JSON.parse((await readBody(req)) || '{}') as { planId?: string };
          if (!planId) return json(res, 400, { ok: false, reason: 'body needs { planId }' });
          return jsonBig(res, 200, await index.ingestPlan(planId));
        }
        if (req.method === 'POST' && pathname === '/index/mandate') {
          this.auth(apiKey);
          const { mandateId } = JSON.parse((await readBody(req)) || '{}') as { mandateId?: string };
          if (!mandateId) return json(res, 400, { ok: false, reason: 'body needs { mandateId }' });
          return jsonBig(res, 200, await index.ingestMandate(mandateId));
        }

        // PUBLIC ingest (no api-key) — for wallet-based dashboards/checkout with no api-key. Safe:
        // each re-derives the row from a chain point-read, so it only ever indexes public on-chain
        // objects (a bad/garbage id just errors). Idempotent upsert by id.
        if (req.method === 'POST' && pathname === '/relations/plan') {
          const { planId } = JSON.parse((await readBody(req)) || '{}') as { planId?: string };
          if (!planId) return json(res, 400, { ok: false, reason: 'body needs { planId }' });
          return jsonBig(res, 200, await index.ingestPlan(planId));
        }
        if (req.method === 'POST' && pathname === '/relations/mandate') {
          const { mandateId } = JSON.parse((await readBody(req)) || '{}') as { mandateId?: string };
          if (!mandateId) return json(res, 400, { ok: false, reason: 'body needs { mandateId }' });
          return jsonBig(res, 200, await index.ingestMandate(mandateId));
        }
        if (req.method === 'POST' && pathname === '/relations/account') {
          const { accountId } = JSON.parse((await readBody(req)) || '{}') as { accountId?: string };
          if (!accountId) return json(res, 400, { ok: false, reason: 'body needs { accountId }' });
          return jsonBig(res, 200, await index.ingestAccount(accountId));
        }

        // merchant dashboard (api-key → the merchant's own on-chain address). "My plans / my subscribers."
        if (req.method === 'GET' && pathname === '/plans') {
          return jsonBig(res, 200, index.plansByMerchant(this.merchantAddr(apiKey)));
        }
        if (req.method === 'GET' && pathname === '/mandates') {
          return jsonBig(res, 200, index.mandatesByMerchant(this.merchantAddr(apiKey)));
        }

        // public relationship reads (mandates/plans/accounts are public shared objects on-chain;
        // the index only makes them queryable). Address-keyed — for the wallet-based subscriber portal.
        if (req.method === 'GET' && pathname === '/relations/mandates') {
          if (query.plan) return jsonBig(res, 200, index.mandatesByPlan(query.plan));
          if (query.subscriber) {
            // ?discover=1 → reconcile against chain first (find + ingest mandates the index missed),
            // so the subscriber portal lists their COMPLETE set. Needs rpcUrl + packageId; without
            // them (or if the event scan fails) fall back to the plain index read.
            if (query.discover && this.o.rpcUrl && this.o.packageId) {
              try {
                return jsonBig(res, 200, await index.discoverMandatesBySubscriber(query.subscriber, { rpcUrl: this.o.rpcUrl, packageId: this.o.packageId }));
              } catch {
                /* RPC unreachable / scan failed — degrade to the cached index view below */
              }
            }
            return jsonBig(res, 200, index.mandatesBySubscriber(query.subscriber));
          }
          if (query.merchant) return jsonBig(res, 200, index.mandatesByMerchant(query.merchant));
          return json(res, 400, { reason: 'need one of ?plan= | ?subscriber= | ?merchant=' });
        }
        if (req.method === 'GET' && pathname === '/relations/plans') {
          if (!query.merchant) return json(res, 400, { reason: 'need ?merchant=' });
          return jsonBig(res, 200, index.plansByMerchant(query.merchant));
        }
        if (req.method === 'GET' && pathname === '/relations/accounts') {
          if (!query.owner) return json(res, 400, { reason: 'need ?owner=' });
          return jsonBig(res, 200, index.accountsByOwner(query.owner));
        }

        // per-mandate time-series for the usage chart (public, by mandate id; on-chain-public data).
        if (req.method === 'GET' && pathname === '/usage') {
          if (!query.mandateId) return json(res, 400, { reason: 'need ?mandateId=' });
          return jsonBig(res, 200, usageByMandate(this.o.db, query.mandateId));
        }
        if (req.method === 'GET' && pathname === '/charges') {
          if (!query.mandateId) return json(res, 400, { reason: 'need ?mandateId=' });
          return jsonBig(res, 200, chargesByMandate(this.o.db, query.mandateId));
        }

        // monthly compliance / reconciliation report — CSV (default) or JSON, current month unless
        // ?month=YYYY-MM. Public (it only aggregates on-chain-public charges, like the reads above).
        //   GET /report?subscriber=<addr>            → "payments I made" (CSV download)
        //   GET /report?merchant=<addr>&month=2026-05 → "payments I received" for May
        //   …&format=json                            → the structured report
        if (req.method === 'GET' && pathname === '/report') {
          const party = query.subscriber ? ('subscriber' as const) : query.merchant ? ('merchant' as const) : null;
          const address = query.subscriber ?? query.merchant;
          if (!party || !address) return json(res, 400, { reason: 'need ?subscriber=<addr> or ?merchant=<addr> (optional &month=YYYY-MM, &format=json)' });
          let range: { startMs: number; endMs: number; label: string };
          try {
            range = query.month ? monthRangeFromLabel(query.month) : currentMonthUtc();
          } catch (e) {
            return json(res, 400, { reason: e instanceof Error ? e.message : 'bad month' });
          }
          const mandates = party === 'subscriber' ? index.mandatesBySubscriber(address) : index.mandatesByMerchant(address);
          const charges = mandates.flatMap((m) =>
            chargesByMandate(this.o.db, m.mandateId).map((c) => ({ mandateId: m.mandateId, amount: c.amount, seq: c.seq, digest: c.digest, atMs: c.atMs })),
          );
          const report = buildComplianceReport({
            party,
            address,
            asset: '0x2::sui::SUI',
            network: this.o.network,
            periodStartMs: range.startMs,
            periodEndMs: range.endMs,
            periodLabel: range.label,
            generatedAtMs: Date.now(),
            mandates: mandates.map((m) => ({ mandateId: m.mandateId, merchant: m.merchant, subscriber: m.subscriber, planId: m.planId })),
            charges,
          });
          if (query.format === 'json') return jsonBig(res, 200, report);
          const csv = reportToCsv(report, { explorerTxBase: this.o.network ? `https://suiscan.xyz/${this.o.network}/tx/` : undefined });
          res.statusCode = 200;
          res.setHeader('content-type', 'text/csv; charset=utf-8');
          res.setHeader('content-disposition', `attachment; filename="isub-${party}-${address.slice(0, 10)}-${range.label}.csv"`);
          res.end(csv);
          return;
        }
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
/** Like `json`, but encodes bigint fields (the index rows) as decimal strings — JSON has no bigint. */
function jsonBig(res: ServerResponse, status: number, obj: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
/** Split a request URL into its pathname and a flat query map (no external deps). */
function parseUrl(url: string): { pathname: string; query: Record<string, string> } {
  const u = new URL(url, 'http://localhost');
  const query: Record<string, string> = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  return { pathname: u.pathname, query };
}

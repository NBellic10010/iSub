// `@isub/sdk/client` — the THIN client a merchant imports to use the MANAGED gateway.
//
// This is the whole merchant-side surface: an api-key, three calls, and a webhook
// verifier. NO heavy deps (no IsubClient / keeper / biller / DB / chain) — just HTTP
// + an HMAC check. A non-Node backend can skip this package entirely and speak the
// same HTTP + signature scheme directly; this is the convenience wrapper for Node.
import { verifyWebhook } from './webhook';

export { verifyWebhook };
export type { WebhookEvent, VerifyOptions } from './webhook';

/** 200 = served · 402 = gated (out of budget / not serviceable) · 403 = bad credential. */
export interface UseResponse {
  ok: boolean;
  status: number;
  reason?: string;
}

export interface SubscriptionStatus {
  serviceable: boolean;
  remaining: string; // base units, decimal string (bigint-safe)
  reason?: string;
}

// Relationship-index rows as carried over HTTP — every on-chain u64 is a decimal STRING
// (JSON has no bigint; wrap with BigInt() where you need arithmetic). Mirrors `@isub/sdk/relations`.
export interface PlanRowJson {
  planId: string; merchant: string; mode: number;
  price: string; intervalMs: string; rateCap: string; rateWindowMs: string;
  keeper: string; active: boolean; updatedAt: number;
}
export interface MandateRowJson {
  mandateId: string; accountId: string; subscriber: string; merchant: string; planId: string;
  mode: number; status: number; spentTotal: string; totalBudget: string; expiryMs: string;
  chargeSeq: string; updatedAt: number;
}
export interface AccountRowJson {
  accountId: string; owner: string; updatedAt: number;
}

export class IsubServiceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Report this call's metered usage against the agent's mandate (the payment credential).
   * Call it in your own request handler; gate delivery on `ok`/`status`. Idempotent by
   * `usageId` — safe to retry. The gateway meters, aggregates, and settles on-chain.
   */
  async use(mandateId: string, amount: bigint, usageId: string): Promise<UseResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-isub-api-key': this.apiKey, 'x-isub-mandate': mandateId },
      body: JSON.stringify({ amount: amount.toString(), usageId }),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<UseResponse>;
    return { ok: res.ok, status: res.status, reason: data.reason };
  }

  /** Current serviceability + remaining-budget estimate for a mandate (null if unknown). */
  async status(mandateId: string): Promise<SubscriptionStatus | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/subscriptions/${mandateId}`, {
      headers: { 'x-isub-api-key': this.apiKey },
    });
    if (res.status === 404) return null;
    return (await res.json()) as SubscriptionStatus;
  }

  // ===== relationship index (dashboard reads + write-time capture) =====
  // The chain can't list these (gRPC has no event query / no enumerate-by-owner); the gateway's
  // index does, in one call. Requires the gateway to be constructed with an `index` (else 404).

  /** Record a plan in the index right after you create it on-chain (so it shows up in lists). */
  async indexPlan(planId: string): Promise<PlanRowJson> {
    return this.json<PlanRowJson>('POST', '/index/plan', { planId });
  }
  /** Record a mandate (and its account) right after `authorize*` returns its id. */
  async indexMandate(mandateId: string): Promise<MandateRowJson> {
    return this.json<MandateRowJson>('POST', '/index/mandate', { mandateId });
  }

  /** This merchant's plans (api-key scoped to your address). */
  async listPlans(): Promise<PlanRowJson[]> {
    return this.json<PlanRowJson[]>('GET', '/plans');
  }
  /** Every mandate (subscriber) against this merchant's plans. */
  async listMandates(): Promise<MandateRowJson[]> {
    return this.json<MandateRowJson[]>('GET', '/mandates');
  }
  /** The plan↔user mapping: every mandate (subscriber) on a plan. */
  async mandatesByPlan(planId: string): Promise<MandateRowJson[]> {
    return this.json<MandateRowJson[]>('GET', `/relations/mandates?plan=${encodeURIComponent(planId)}`);
  }
  /** A subscriber's mandates across ALL merchants (public; for the wallet-based subscriber portal). */
  async mandatesBySubscriber(subscriber: string): Promise<MandateRowJson[]> {
    return this.json<MandateRowJson[]>('GET', `/relations/mandates?subscriber=${encodeURIComponent(subscriber)}`);
  }
  /** An owner's accounts (public). */
  async accountsByOwner(owner: string): Promise<AccountRowJson[]> {
    return this.json<AccountRowJson[]>('GET', `/relations/accounts?owner=${encodeURIComponent(owner)}`);
  }

  private async json<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-isub-api-key': this.apiKey },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    return (await res.json()) as T;
  }
}

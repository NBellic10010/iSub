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
}

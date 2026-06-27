// `@isubpay/sdk/client` — the THIN client a merchant imports to use the MANAGED gateway.
//
// This is the whole merchant-side surface: an api-key, the report/read calls, and a webhook
// verifier. NO heavy deps (no IsubClient / keeper / biller / DB / chain) — just HTTP
// + an HMAC check. A non-Node backend can skip this package entirely and speak the
// same HTTP + signature scheme directly; this is the convenience wrapper for Node.
//
// AUTH POSTURE — the gateway's metered-report doors (`/usage`, `/usage-metered`) are SECURE BY
// DEFAULT (the tenant resolves to agentAuth:'enforce' unless told otherwise). Two supported shapes:
//   • Trusted merchant backend self-metering its OWN users — this client holds the api-key on YOUR
//     server, so the api-key IS the trust boundary. Set the tenant's `routing.agentAuthMode:'off'`
//     and call `use`/`useMetered` with no `proof`. (This is what `managed-e2e` exercises.)
//   • Untrusted agent reporting through a shared api-key — keep the tenant 'enforce' and pass a
//     per-call `proof` (an agent proof-of-possession; see `@isubpay/sdk` `signCall`/`issueAgentCert`).
//   Omitting BOTH on an 'enforce' tenant → 403 (the bearer-mandateId door is closed). See
//   docs/guides/managed-gateway.md.
import { verifyWebhook } from './webhook';
import type { CallProof } from './agent-auth';

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
// (JSON has no bigint; wrap with BigInt() where you need arithmetic). Mirrors `@isubpay/sdk/relations`.
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

/**
 * Serialize a `CallProof` into the flat HTTP body fields the gateway reconstructs via
 * `proofFromFields` (`agentSig` / `agentSigNotAfter` / `agentCert`). bigints → decimal strings
 * (JSON has no bigint). Returns `{}` for no proof, so an unsigned body is unchanged.
 */
function proofFields(proof?: CallProof): Record<string, unknown> {
  if (!proof) return {};
  return {
    agentSig: proof.sig,
    agentSigNotAfter: proof.notAfter.toString(),
    ...(proof.cert
      ? { agentCert: { agent: proof.cert.agent, notAfter: proof.cert.notAfter.toString(), ver: proof.cert.ver, sig: proof.cert.sig } }
      : {}),
  };
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
   * Report this call's metered usage against the agent's mandate (the payment credential), with the
   * `amount` you priced. Call it in your own request handler; gate delivery on `ok`/`status`.
   * Idempotent by `usageId` — safe to retry. The gateway meters, aggregates, and settles on-chain.
   *
   * `proof` is OPTIONAL: omit it when this tenant is `agentAuthMode:'off'` (trusted backend
   * self-metering); pass an agent PoP when the tenant is 'enforce' (untrusted agent via shared
   * api-key). On an 'enforce' tenant a call with no proof is rejected 403. See the header note.
   */
  async use(mandateId: string, amount: bigint, usageId: string, proof?: CallProof): Promise<UseResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-isub-api-key': this.apiKey, 'x-isub-mandate': mandateId },
      body: JSON.stringify({ amount: amount.toString(), usageId, ...proofFields(proof) }),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<UseResponse>;
    return { ok: res.ok, status: res.status, reason: data.reason };
  }

  /**
   * Report RAW usage QUANTITIES; the gateway prices them with this tenant's on-chain RateCard and
   * settles the frozen amount. Mirrors `use` but for metered billing — the gateway must be
   * configured with `routing.rateCard` for this tenant (else the report errors). Same idempotency
   * (`usageId`) + optional-`proof` auth contract as `use`.
   */
  async useMetered(
    mandateId: string,
    items: ReadonlyArray<{ meterKey: string; qty: bigint }>,
    usageId: string,
    proof?: CallProof,
  ): Promise<UseResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/usage-metered`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-isub-api-key': this.apiKey, 'x-isub-mandate': mandateId },
      body: JSON.stringify({ items: items.map((i) => ({ meterKey: i.meterKey, qty: i.qty.toString() })), usageId, ...proofFields(proof) }),
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

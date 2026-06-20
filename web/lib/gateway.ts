// ===== The iSub managed gateway client (off-chain relationship index + usage) =====
//
// The on-chain reads go through @isub/sdk + the wallet (use-isub.ts). This is the seam to the
// gateway's OFF-CHAIN relationship index — the part gRPC can't serve (merchant→plans,
// subscriber→mandates across merchants, owner→accounts). It mirrors @isub/sdk/gateway's HTTP routes.
//
// The wallet-based dashboards use the PUBLIC, address-keyed routes (no api-key — these are public
// on-chain objects, just made queryable) + public write-time ingest. The api-key routes
// (`listPlans`/`listMandates`) remain for the managed thin-client path. All u64s cross the wire as
// decimal STRINGS (JSON has no bigint).

export interface UseResult {
  ok: boolean;
  status: number;
  reason?: string;
}
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
export interface UsagePointJson {
  usageId: string; mandateId: string; amount: string; atMs: number;
  meterKey: string | null; qty: string | null; rateCardVersion: number | null; billed: boolean;
}
export interface ChargePointJson {
  mandateId: string; kind: string; amount: string | null; seq: number | null; digest: string | null; atMs: number;
}

export interface GatewayClient {
  health(): Promise<{ ok: boolean }>;
  // ---- public, address-keyed relationship reads (no api-key) ----
  plansByMerchant(merchant: string): Promise<PlanRowJson[]>;
  mandatesBySubscriber(subscriber: string): Promise<MandateRowJson[]>;
  mandatesByPlan(planId: string): Promise<MandateRowJson[]>;
  accountsByOwner(owner: string): Promise<AccountRowJson[]>;
  // ---- per-mandate usage chart (public, by mandate id) ----
  usage(mandateId: string): Promise<UsagePointJson[]>;
  charges(mandateId: string): Promise<ChargePointJson[]>;
  // ---- public write-time ingest (re-derives the row from chain) ----
  ingestPlan(planId: string): Promise<PlanRowJson>;
  ingestMandate(mandateId: string): Promise<MandateRowJson>;
  ingestAccount(accountId: string): Promise<AccountRowJson>;
  // ---- api-key scoped (managed thin-client path) ----
  listPlans?(): Promise<PlanRowJson[]>;
  listMandates?(): Promise<MandateRowJson[]>;
}

export interface GatewayConfig {
  baseUrl: string;
  /** Merchant api-key (managed path only). The wallet dashboards don't need it — they use the public routes. */
  apiKey?: string;
}

/** Gateway base URL — `NEXT_PUBLIC_GATEWAY_URL` at build, else a local dev default. */
export const GATEWAY_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_GATEWAY_URL) || 'http://localhost:4000';

/** The default gateway client the dashboards use (public routes, no api-key). */
export function webGateway(): GatewayClient {
  return gatewayClient({ baseUrl: GATEWAY_URL });
}

export function gatewayClient(cfg: GatewayConfig): GatewayClient {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'content-type': 'application/json',
    ...(cfg.apiKey ? { 'x-isub-api-key': cfg.apiKey } : {}),
    ...extra,
  });
  const getJson = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${base}${path}`, { headers: headers() });
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return (await r.json()) as T;
  };
  const postJson = async <T>(path: string, body: unknown): Promise<T> => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    async health() {
      return getJson<{ ok: boolean }>('/health');
    },
    plansByMerchant: (merchant) => getJson<PlanRowJson[]>(`/relations/plans?merchant=${encodeURIComponent(merchant)}`),
    mandatesBySubscriber: (subscriber) => getJson<MandateRowJson[]>(`/relations/mandates?subscriber=${encodeURIComponent(subscriber)}`),
    mandatesByPlan: (planId) => getJson<MandateRowJson[]>(`/relations/mandates?plan=${encodeURIComponent(planId)}`),
    accountsByOwner: (owner) => getJson<AccountRowJson[]>(`/relations/accounts?owner=${encodeURIComponent(owner)}`),
    usage: (mandateId) => getJson<UsagePointJson[]>(`/usage?mandateId=${encodeURIComponent(mandateId)}`),
    charges: (mandateId) => getJson<ChargePointJson[]>(`/charges?mandateId=${encodeURIComponent(mandateId)}`),
    ingestPlan: (planId) => postJson<PlanRowJson>('/relations/plan', { planId }),
    ingestMandate: (mandateId) => postJson<MandateRowJson>('/relations/mandate', { mandateId }),
    ingestAccount: (accountId) => postJson<AccountRowJson>('/relations/account', { accountId }),
    listPlans: () => getJson<PlanRowJson[]>('/plans'),
    listMandates: () => getJson<MandateRowJson[]>('/mandates'),
  };
}

// ===== INTERFACE POINT: the iSub managed gateway (off-chain merchant data) =====
//
// The subscriber app is ON-CHAIN ONLY (it goes through @isub/sdk + the wallet — see use-isub.ts).
// The MERCHANT dashboard needs off-chain data the gateway owns (api keys, usage, webhooks,
// invoices, lag). This is the typed seam to it. Methods marked EXISTS are already served by
// `@isub/sdk/gateway` (IsubGateway HTTP front); methods marked TODO are to be added there
// (the dashboard read API) — they throw until then, so the UI can be built against the contract.
//
// Reuse: this maps 1:1 onto the gateway's existing HTTP routes; merchant auth is the api-key
// header the gateway already checks (later upgraded to a SIWS session — see lib/auth seam).

export interface UseResult {
  ok: boolean;
  status: number;
  reason?: string;
}

export interface GatewayClient {
  // ---- EXISTS in @isub/sdk/gateway today ----
  health(): Promise<{ ok: boolean }>; // GET /health
  subscriptionStatus(mandateId: string): Promise<{ serviceable: boolean; remaining: string; reason?: string } | null>; // GET /subscriptions/:id
  reportUsage(mandateId: string, amount: bigint, usageId: string): Promise<UseResult>; // POST /usage
  reportMeteredUsage(mandateId: string, items: { meterKey: string; qty: bigint }[], usageId: string): Promise<UseResult>; // POST /usage-metered

  // ---- TODO: merchant dashboard read API (extend gateway.ts) ----
  /** List the merchant's plans. */
  listPlans?(): Promise<unknown[]>;
  /** Mandates against the merchant's plans (subscribers). */
  listMandates?(): Promise<unknown[]>;
  /** Usage records (priced line items) for a mandate. */
  usage?(mandateId: string): Promise<unknown[]>;
  /** Settlement invoices for a mandate/period. */
  invoices?(mandateId: string): Promise<unknown[]>;
  /** Schedule-lag / 漏收入 report across the merchant's mandates. */
  scheduleLag?(): Promise<unknown>;
}

export interface GatewayConfig {
  baseUrl: string;
  /** Merchant api-key (today) → a SIWS session token (later). */
  apiKey?: string;
}

/** Build a gateway client. EXISTS routes are wired; TODO routes throw a clear "not implemented yet". */
export function gatewayClient(cfg: GatewayConfig): GatewayClient {
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'content-type': 'application/json',
    ...(cfg.apiKey ? { 'x-isub-api-key': cfg.apiKey } : {}),
    ...extra,
  });
  const todo = (name: string) => (): never => {
    throw new Error(`gateway.${name}() not implemented yet — add the read route to @isub/sdk/gateway`);
  };
  return {
    async health() {
      const r = await fetch(`${cfg.baseUrl}/health`);
      return (await r.json()) as { ok: boolean };
    },
    async subscriptionStatus(mandateId) {
      const r = await fetch(`${cfg.baseUrl}/subscriptions/${mandateId}`, { headers: headers() });
      return r.status === 404 ? null : ((await r.json()) as { serviceable: boolean; remaining: string; reason?: string });
    },
    async reportUsage(mandateId, amount, usageId) {
      const r = await fetch(`${cfg.baseUrl}/usage`, {
        method: 'POST',
        headers: headers({ 'x-isub-mandate': mandateId }),
        body: JSON.stringify({ amount: amount.toString(), usageId }),
      });
      return (await r.json()) as UseResult;
    },
    async reportMeteredUsage(mandateId, items, usageId) {
      const r = await fetch(`${cfg.baseUrl}/usage-metered`, {
        method: 'POST',
        headers: headers({ 'x-isub-mandate': mandateId }),
        body: JSON.stringify({ items: items.map((i) => ({ meterKey: i.meterKey, qty: i.qty.toString() })), usageId }),
      });
      return (await r.json()) as UseResult;
    },
    listPlans: todo('listPlans'),
    listMandates: todo('listMandates'),
    usage: todo('usage'),
    invoices: todo('invoices'),
    scheduleLag: todo('scheduleLag'),
  };
}

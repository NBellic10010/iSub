// `./x402` — iSub's OWN x402 implementation (buyer + seller), the `mandate` scheme.
//
// x402 ships an `exact` scheme: the buyer signs a fresh on-chain TRANSFER tx per call, the
// facilitator submits it (one-shot push). iSub adds a DIFFERENT scheme — `mandate` — where the
// buyer does NOT sign a fresh transfer each time; it presents a proof-of-possession over a STANDING
// on-chain iSub Mandate, and the facilitator settles through iSub's recurring/metered, capped,
// idempotent biller (`charge_metered`). So the same x402 wire protocol carries RECURRING + METERED
// pulls, on-chain-enforced caps, not just a single transfer.
//
// Three faces, x402-V2-wire-compatible (own types, no external dep; interoperable by shape):
//   • SELLER     — `buildPaymentRequirements()` → the 402 challenge (scheme/network/payTo/asset/amount).
//   • BUYER      — `createMandatePayment()` → the X-PAYMENT payload (the agent-auth PoP), no fresh tx.
//   • FACILITATOR— `MandateFacilitator.verify()` (cheap, no chain) + `.settle()` (the SINGLE
//                  `IsubService` chokepoint → caps + PoP + accrue; agentAuth must be 'enforce').
//
// Settlement is HYBRID per the interface ADR: /verify is side-effect-free; /settle defaults to
// PROVISIONAL (accrue into the batch — on-chain at flush, "at-most-once within caps, timing not
// guaranteed"). A true in-band on-chain digest ("final") is a follow-up once `service.flush` is
// widened to return FlushResult[]. Server-only shell (like gateway/mcp); reuses agent-auth + service.
import { Buffer } from 'node:buffer';
import { signCall, callMessage, payloadOf, verifyCallProof, proofFromFields, type AgentCert, type MessageSigner } from './agent-auth';
import type { IsubService } from './service';

export const X402_VERSION = 2;
/** iSub's scheme: pay via a standing on-chain Mandate (recurring/metered/capped), not a one-shot transfer. */
export const ISUB_SCHEME = 'mandate';
export type X402Network = 'sui-testnet' | 'sui-mainnet' | 'sui-localnet';

/** x402 PaymentRequirements (the 402 challenge). u64s cross the wire as decimal strings. */
export interface PaymentRequirements {
  scheme: string;
  network: X402Network;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}
export interface PaymentRequiredBody {
  x402Version: number;
  accepts: PaymentRequirements[];
  error?: string;
}
/** The `mandate`-scheme payload carried inside X-PAYMENT — the agent-auth proof, NOT a signed transfer. */
export interface MandatePayload {
  mandateId: string;
  usageId: string;
  sig: string;
  notAfter: string;
  cert?: { agent: string; notAfter: string; ver: number; sig: string };
  /** Flat charge (mutually exclusive with `items`) — must equal `maxAmountRequired`. */
  amount?: string;
  /** Metered charge (priced by the service's RateCard at settle). */
  items?: { meterKey: string; qty: string }[];
}
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: X402Network;
  payload: MandatePayload;
}
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  settlement?: 'provisional' | 'final';
  /** Honest guarantee string — provisional is the resource server's promise, NOT a chain proof. */
  guarantee?: string;
  mandateId?: string;
  usageId?: string;
  amount?: string;
  /** On-chain digest — present only for `final`; null for provisional (settles at flush). */
  txHash?: string | null;
}

// ===== header codec (X-PAYMENT / 402 body cross the wire as base64 JSON) =====
export function encodePayment(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}
export function decodePayment(header: string): PaymentPayload {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload;
}

// ===== SELLER =====
/** Build the 402 challenge for a charge payable via an iSub mandate. `amount` is the authoritative ceiling. */
export function buildPaymentRequirements(p: {
  amount: bigint;
  payTo: string;
  asset: string;
  network: X402Network;
  resource: string;
  description?: string;
  metered?: boolean;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}): PaymentRequirements {
  return {
    scheme: ISUB_SCHEME,
    network: p.network,
    maxAmountRequired: p.amount.toString(),
    resource: p.resource,
    description: p.description,
    payTo: p.payTo,
    asset: p.asset,
    maxTimeoutSeconds: p.maxTimeoutSeconds,
    extra: { metered: !!p.metered, ...p.extra },
  };
}
export function paymentRequired(accepts: PaymentRequirements[], error?: string): PaymentRequiredBody {
  return { x402Version: X402_VERSION, accepts, error };
}

// ===== BUYER =====
/**
 * Turn a 402 challenge into a signed X-PAYMENT by presenting a proof-of-possession over your iSub
 * mandate — NO fresh on-chain transfer. The agent key must be authorized by `cert` (subscriber-signed).
 * Flat by default (amount = challenge's maxAmountRequired); pass `charge.items` for a metered call.
 */
export async function createMandatePayment(p: {
  requirements: PaymentRequirements;
  mandateId: string;
  usageId: string;
  agent: MessageSigner;
  cert: AgentCert;
  charge?: { items: ReadonlyArray<{ meterKey: string; qty: bigint }> };
  ttlMs?: number;
  nowMs?: bigint;
}): Promise<PaymentPayload> {
  if (p.requirements.scheme !== ISUB_SCHEME) throw new Error(`x402: unsupported scheme ${p.requirements.scheme} (expected ${ISUB_SCHEME})`);
  const now = p.nowMs ?? BigInt(Date.now());
  const notAfter = now + BigInt(p.ttlMs ?? 60_000);
  const items = p.charge?.items;
  // The signed payload binds the PoP to EXACTLY this charge — flat amount or sorted meter items.
  const signedPayload = items ? payloadOf(items) : payloadOf(undefined, BigInt(p.requirements.maxAmountRequired));
  const { sig } = await signCall(p.agent, { mandateId: p.mandateId, usageId: p.usageId, merchant: p.requirements.payTo, payload: signedPayload, notAfter });
  const cert = { agent: p.cert.agent, notAfter: p.cert.notAfter.toString(), ver: p.cert.ver, sig: p.cert.sig };
  const body: MandatePayload = items
    ? { mandateId: p.mandateId, usageId: p.usageId, sig, notAfter: notAfter.toString(), cert, items: items.map((i) => ({ meterKey: i.meterKey, qty: i.qty.toString() })) }
    : { mandateId: p.mandateId, usageId: p.usageId, sig, notAfter: notAfter.toString(), cert, amount: p.requirements.maxAmountRequired };
  return { x402Version: X402_VERSION, scheme: ISUB_SCHEME, network: p.requirements.network, payload: body };
}

// ===== FACILITATOR =====
export class MandateFacilitator {
  constructor(
    private readonly service: IsubService,
    private readonly network: X402Network,
  ) {}

  /** Cheap pre-check (NO chain): scheme/network match + the PoP signature recovers to the cert's agent. */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    if (payload.scheme !== ISUB_SCHEME || requirements.scheme !== ISUB_SCHEME) return { isValid: false, invalidReason: 'scheme_mismatch' };
    if (payload.network !== requirements.network || payload.network !== this.network) return { isValid: false, invalidReason: 'network_mismatch' };
    const m = payload.payload;
    if (!m?.sig || !m.cert) return { isValid: false, invalidReason: 'missing_proof_or_cert' };
    if (!m.items && m.amount !== requirements.maxAmountRequired) return { isValid: false, invalidReason: 'amount_mismatch' };
    const notAfter = BigInt(m.notAfter);
    const signedPayload = m.items
      ? payloadOf(m.items.map((i) => ({ meterKey: i.meterKey, qty: BigInt(i.qty) })))
      : payloadOf(undefined, BigInt(m.amount ?? requirements.maxAmountRequired));
    const msg = callMessage({ mandateId: m.mandateId, usageId: m.usageId, merchant: requirements.payTo, payload: signedPayload, notAfter });
    const ok = await verifyCallProof(msg, m.sig, m.cert.agent, BigInt(Date.now()), notAfter);
    // The AUTHORITATIVE gate (subscriber-binding vs on-chain subscriber + caps/budget) runs in settle.
    return ok ? { isValid: true, payer: m.cert.agent } : { isValid: false, invalidReason: 'invalid_signature' };
  }

  /** Authoritative: route through the SINGLE IsubService (caps + PoP + accrue). Provisional by default. */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    if (payload.scheme !== ISUB_SCHEME) return { success: false, errorReason: 'scheme_mismatch' };
    const m = payload.payload;
    const proof = proofFromFields({ agentSig: m.sig, agentSigNotAfter: m.notAfter, agentCert: m.cert });
    // x402 is the agent-facing route → ALWAYS enforce PoP, hard-coded here (never from the client
    // payload). Same single IsubService/biller a merchant self-metering route uses with authMode 'off'.
    const r = m.items
      ? await this.service.useMetered(m.mandateId, m.items.map((i) => ({ meterKey: i.meterKey, qty: BigInt(i.qty) })), m.usageId, proof, 'enforce')
      : await this.service.use(m.mandateId, BigInt(m.amount ?? requirements.maxAmountRequired), m.usageId, proof, 'enforce');
    if (!r.ok) return { success: false, errorReason: `${r.status}${r.reason ? ' ' + r.reason : ''}` };
    return {
      success: true,
      settlement: 'provisional',
      guarantee: 'at-most-once within mandate caps; on-chain settlement timing not guaranteed',
      mandateId: m.mandateId,
      usageId: m.usageId,
      amount: m.items ? undefined : (m.amount ?? requirements.maxAmountRequired),
      txHash: null,
    };
  }
}

// ===== BUYER fetch loop (HTTP 402 round-trip) =====
/** Minimal fetch shape — global `fetch` (Node 18+ / browser) satisfies it structurally. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string>; headers?: { get: (name: string) => string | null } }>;

export interface X402PayResult {
  status: number;
  ok: boolean;
  /** true if a 402 was answered with an X-PAYMENT and retried. */
  paid: boolean;
  body: string;
  /** the mandate-scheme requirement that was satisfied (present only when paid). */
  requirements?: PaymentRequirements;
  /** the seller's `X-PAYMENT-RESPONSE` (settlement receipt: digest/explorer/spent) if present. */
  paymentResponse?: string;
}

/**
 * Request `url`; if it answers 402 with a `mandate`-scheme challenge, present an X-PAYMENT (a PoP over
 * the standing mandate — NO fresh transfer tx) and retry ONCE. This is the agent's buyer side of the
 * loop; wrap it as an MCP `pay` tool so natural language ("access this paid API") triggers payment.
 */
export async function payViaX402(
  fetchImpl: FetchLike,
  url: string,
  opts: {
    mandateId: string;
    agent: MessageSigner;
    cert: AgentCert;
    usageId: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    charge?: { items: ReadonlyArray<{ meterKey: string; qty: bigint }> };
    nowMs?: bigint;
  },
): Promise<X402PayResult> {
  const method = opts.method ?? 'GET';
  const baseHeaders = { ...(opts.headers ?? {}) };
  const first = await fetchImpl(url, { method, headers: baseHeaders, body: opts.body });
  if (first.status !== 402) {
    return { status: first.status, ok: first.ok, paid: false, body: await first.text() };
  }
  const challenge = JSON.parse(await first.text()) as PaymentRequiredBody;
  const requirements = (challenge.accepts ?? []).find((a) => a.scheme === ISUB_SCHEME);
  if (!requirements) {
    const offered = (challenge.accepts ?? []).map((a) => a.scheme).join(', ') || 'none';
    throw new Error(`x402: server offered no '${ISUB_SCHEME}' scheme (got: ${offered})`);
  }
  const payment = await createMandatePayment({
    requirements,
    mandateId: opts.mandateId,
    usageId: opts.usageId,
    agent: opts.agent,
    cert: opts.cert,
    charge: opts.charge,
    nowMs: opts.nowMs,
  });
  const retried = await fetchImpl(url, {
    method,
    headers: { ...baseHeaders, 'X-PAYMENT': encodePayment(payment) },
    body: opts.body,
  });
  return {
    status: retried.status,
    ok: retried.ok,
    paid: true,
    body: await retried.text(),
    requirements,
    paymentResponse: retried.headers?.get('x-payment-response') ?? undefined,
  };
}

// `./x402` — iSub's x402 implementation (buyer + seller + facilitator). iSub speaks BOTH schemes:
//
//   • `exact` — the STANDARD x402 V2 scheme (the upstream-adopted one). The buyer signs a fresh
//     on-chain TRANSFER of the exact amount to the merchant with its OWN key; the facilitator
//     SIMULATES it (rejecting anything that doesn't pay exactly right) then EXECUTES the buyer's
//     signed bytes, returning the real on-chain digest (`final`). A payer needs NOTHING iSub-specific
//     — any x402 client can pay an iSub merchant. This is the interop path: one-off, per-call, push.
//
//   • `mandate` — iSub's OWN extension for what `exact` cannot express. The buyer does NOT sign a
//     fresh transfer each time; it presents a proof-of-possession over a STANDING on-chain iSub
//     Mandate, and the facilitator settles through iSub's recurring/metered, capped, idempotent
//     biller (`charge_metered`). The SAME x402 wire carries RECURRING + METERED pulls with
//     on-chain-enforced caps — the layer a one-shot `exact` push has no concept of.
//
// A 402 can offer EITHER or BOTH (`accepts: [exact, mandate]`): standard `exact` for a one-off payer,
// `mandate` for a subscriber's agent pulling within a cap with no fresh tx.
//
// Faces, x402-V2-wire-compatible:
//   • SELLER     — `buildExactRequirements()` / `buildPaymentRequirements()` → the 402 challenge.
//   • BUYER      — `createExactPayment()` (sign a real transfer) / `createMandatePayment()` (PoP, no tx).
//   • FACILITATOR— `ExactFacilitator` (simulate → execute, returns a FINAL on-chain digest) /
//                  `MandateFacilitator` (cheap verify → IsubService settle: caps + PoP + accrue).
//
// Mandate settlement is HYBRID per the interface ADR: /verify is side-effect-free; /settle defaults to
// PROVISIONAL (accrue into the batch — on-chain at flush, "at-most-once within caps, timing not
// guaranteed"). `exact` settlement is FINAL (the buyer's own signed tx, executed in-band → digest).
// Server-only shell (like gateway/mcp); reuses agent-auth + service.
import { Buffer } from 'node:buffer';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { fromBase64, toBase64, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import type { Signer } from '@mysten/sui/cryptography';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { signCall, callMessage, payloadOf, verifyCallProof, proofFromFields, type AgentCert, type MessageSigner } from './agent-auth';
import type { IsubService } from './service';

export const X402_VERSION = 2;
/** iSub's scheme: pay via a standing on-chain Mandate (recurring/metered/capped), not a one-shot transfer. */
export const ISUB_SCHEME = 'mandate';
/** The STANDARD x402 V2 scheme — a one-shot on-chain transfer signed by the buyer's own key. */
export const EXACT_SCHEME = 'exact';
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
/** The `exact`-scheme payload carried inside X-PAYMENT — the buyer's OWN signed transfer. */
export interface ExactPayload {
  /** base64 BCS transaction bytes: a transfer of exactly `maxAmountRequired` of `asset` to `payTo`. */
  transaction: string;
  /** base64 signature over those bytes, by the buyer's own key (the payer). */
  signature: string;
}
export interface ExactPaymentPayload {
  x402Version: number;
  scheme: string;
  network: X402Network;
  payload: ExactPayload;
}
/** Either scheme's X-PAYMENT envelope; discriminate on `scheme` (`EXACT_SCHEME` | `ISUB_SCHEME`). */
export type AnyPaymentPayload = PaymentPayload | ExactPaymentPayload;
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
export function encodePayment(p: AnyPaymentPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}
export function decodePayment<T extends AnyPaymentPayload = PaymentPayload>(header: string): T {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as T;
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
/**
 * Build a STANDARD x402 `exact` 402 challenge — a one-off transfer of `amount` of `asset` to `payTo`.
 * Offer it alongside a mandate requirement when you want both audiences:
 * `paymentRequired([buildExactRequirements(...), buildPaymentRequirements(...)])`. A standard x402
 * agent satisfies this with nothing iSub-specific — it just signs a transfer and the facilitator settles it.
 */
export function buildExactRequirements(p: {
  amount: bigint;
  payTo: string;
  asset: string;
  network: X402Network;
  resource: string;
  description?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}): PaymentRequirements {
  return {
    scheme: EXACT_SCHEME,
    network: p.network,
    maxAmountRequired: p.amount.toString(),
    resource: p.resource,
    description: p.description,
    payTo: p.payTo,
    asset: p.asset,
    maxTimeoutSeconds: p.maxTimeoutSeconds,
    extra: p.extra,
  };
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

/**
 * Turn an `exact` 402 challenge into a signed X-PAYMENT by building and signing a REAL on-chain
 * transfer of exactly `maxAmountRequired` of `asset` to `payTo`, with the buyer's OWN key. This is the
 * standard x402 path — the facilitator simulates then broadcasts these bytes. (A third-party x402
 * client can produce the same envelope itself; this helper exists for iSub's own agents and tests.)
 */
export async function createExactPayment(p: {
  requirements: PaymentRequirements;
  signer: Signer;
  client: SuiGrpcClient;
  payer?: string;
}): Promise<ExactPaymentPayload> {
  if (p.requirements.scheme !== EXACT_SCHEME) throw new Error(`x402: unsupported scheme ${p.requirements.scheme} (expected ${EXACT_SCHEME})`);
  const tx = new Transaction();
  tx.setSender(p.payer ?? p.signer.toSuiAddress());
  // `coinWithBalance` selects/splits coins of `asset` at build time → exact amount to the merchant.
  tx.transferObjects(
    [coinWithBalance({ balance: BigInt(p.requirements.maxAmountRequired), type: p.requirements.asset })],
    p.requirements.payTo,
  );
  const bytes = await tx.build({ client: p.client });
  const { signature } = await p.signer.signTransaction(bytes);
  return { x402Version: X402_VERSION, scheme: EXACT_SCHEME, network: p.requirements.network, payload: { transaction: toBase64(bytes), signature } };
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

/** The minimal Sui client surface `ExactFacilitator` needs — satisfied structurally by `SuiGrpcClient`
 * (and by a mock in tests): `simulateTransaction` (verify) + `executeTransaction` (settle). */
export interface ExactChainClient {
  simulateTransaction(input: {
    transaction: Uint8Array;
    include?: Record<string, boolean>;
    checksEnabled?: boolean;
  }): Promise<{ $kind: 'Transaction' | 'FailedTransaction'; Transaction?: SimulatedTx; FailedTransaction?: SimulatedTx }>;
  executeTransaction(input: {
    transaction: Uint8Array;
    signatures: string[];
    include?: Record<string, boolean>;
  }): Promise<{ $kind: 'Transaction' | 'FailedTransaction'; Transaction?: ExecutedTx; FailedTransaction?: ExecutedTx }>;
}
interface SimulatedTx {
  status: { success: boolean };
  balanceChanges?: { coinType: string; address: string; amount: string }[];
  transaction?: { sender?: string };
}
interface ExecutedTx {
  digest: string;
  status: { success: boolean };
  balanceChanges?: { coinType: string; address: string; amount: string }[];
}

/**
 * FACILITATOR for the STANDARD `exact` scheme. `verify` SIMULATES the buyer's signed transfer and
 * rejects anything that doesn't credit the merchant EXACTLY (asset + payTo + amount). `settle`
 * EXECUTES the buyer's own signed bytes and returns the real on-chain digest — a `final` settlement
 * (unlike the mandate path's provisional accrual). The facilitator never holds a key and never builds
 * the transfer; it only checks and broadcasts what the buyer already signed.
 */
export class ExactFacilitator {
  constructor(
    private readonly client: ExactChainClient,
    private readonly network: X402Network,
  ) {}

  /** Side-effect-free: simulate the signed tx and assert it pays the merchant exactly. */
  async verify(payload: ExactPaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    if (payload.scheme !== EXACT_SCHEME || requirements.scheme !== EXACT_SCHEME) return { isValid: false, invalidReason: 'scheme_mismatch' };
    if (payload.network !== requirements.network || payload.network !== this.network) return { isValid: false, invalidReason: 'network_mismatch' };
    const ex = payload.payload;
    if (!ex?.transaction || !ex.signature) return { isValid: false, invalidReason: 'missing_tx_or_signature' };
    let sim: Awaited<ReturnType<ExactChainClient['simulateTransaction']>>;
    try {
      sim = await this.client.simulateTransaction({ transaction: fromBase64(ex.transaction), include: { balanceChanges: true, transaction: true } });
    } catch {
      return { isValid: false, invalidReason: 'simulation_error' };
    }
    const t = sim.$kind === 'Transaction' ? sim.Transaction : sim.FailedTransaction;
    if (sim.$kind !== 'Transaction' || !t || !t.status.success) return { isValid: false, invalidReason: 'simulation_failed' };
    const { credit, want } = this.merchantCredit(t.balanceChanges, requirements);
    if (!credit) return { isValid: false, invalidReason: 'no_payment_to_merchant' };
    if (BigInt(credit.amount) !== want) return { isValid: false, invalidReason: 'amount_mismatch' };
    return { isValid: true, payer: t.transaction?.sender };
  }

  /** The merchant's NET balance change of the requested asset + the required amount. The transfer pays
   *  the merchant EXACTLY iff `credit` exists and `BigInt(credit.amount) === want`. Shared by verify + settle. */
  private merchantCredit(
    balanceChanges: { coinType: string; address: string; amount: string }[] | undefined,
    requirements: PaymentRequirements,
  ): { credit?: { coinType: string; address: string; amount: string }; want: bigint } {
    const want = BigInt(requirements.maxAmountRequired);
    const asset = normalizeStructTag(requirements.asset);
    const payTo = normalizeSuiAddress(requirements.payTo);
    const credit = (balanceChanges ?? []).find((b) => normalizeSuiAddress(b.address) === payTo && normalizeStructTag(b.coinType) === asset);
    return { credit, want };
  }

  /** Authoritative: broadcast the buyer's signed transfer. FINAL — returns the on-chain digest.
   *  Re-submitting the same signed bytes is idempotent on Sui (the digest is fixed by the bytes).
   *
   *  settle is SELF-AUTHORITATIVE: x402 permits `/verify` and `/settle` as independent endpoints, so a
   *  settle-only caller must not be able to broadcast a tx that doesn't pay the merchant exactly. So we
   *  (1) re-run the exactness check (simulate) BEFORE executing — a rejection here never broadcasts — and
   *  (2) re-confirm against the LANDED `balanceChanges` after executing, so the `final/exact` guarantee
   *  reflects on-chain reality, not merely `status.success` (a wrong-amount transfer still "succeeds"). */
  async settle(payload: ExactPaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    if (payload.scheme !== EXACT_SCHEME) return { success: false, errorReason: 'scheme_mismatch' };
    const ex = payload.payload;
    if (!ex?.transaction || !ex.signature) return { success: false, errorReason: 'missing_tx_or_signature' };

    // (1) Pre-broadcast gate — simulate + assert exact payment. Reject here = never executed.
    const gate = await this.verify(payload, requirements);
    if (!gate.isValid) return { success: false, errorReason: gate.invalidReason };

    let res: Awaited<ReturnType<ExactChainClient['executeTransaction']>>;
    try {
      res = await this.client.executeTransaction({ transaction: fromBase64(ex.transaction), signatures: [ex.signature], include: { effects: true, balanceChanges: true } });
    } catch (e) {
      return { success: false, errorReason: 'execution_error: ' + (e instanceof Error ? e.message : String(e)) };
    }
    const t = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
    if (res.$kind !== 'Transaction' || !t || !t.status.success) return { success: false, errorReason: 'execution_failed' };

    // (2) Post-broadcast confirmation — the LANDED transfer must credit the merchant exactly, or we do
    //     NOT claim an exact settlement (the tx is on-chain; surface the digest with the failure).
    const { credit, want } = this.merchantCredit(t.balanceChanges, requirements);
    if (!credit || BigInt(credit.amount) !== want) return { success: false, errorReason: 'settled_but_not_exact', txHash: t.digest };

    return {
      success: true,
      settlement: 'final',
      guarantee: "on-chain settled — the buyer's own signed transfer, exact amount to the merchant",
      amount: requirements.maxAmountRequired,
      txHash: t.digest,
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
    const hasExact = (challenge.accepts ?? []).some((a) => a.scheme === EXACT_SCHEME);
    throw new Error(
      `x402: server offered no '${ISUB_SCHEME}' scheme (got: ${offered})` +
        (hasExact ? ` — it offers standard '${EXACT_SCHEME}'; satisfy it with createExactPayment() + a Sui signer, or any x402 client.` : ''),
    );
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

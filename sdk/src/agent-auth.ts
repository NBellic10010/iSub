// `./agent-auth` — proof-of-possession for agent calls (Option a; off-chain, NO contract change).
//
// THE HOLE: a metered tool takes `mandateId` as a BEARER credential. The mandate id is a PUBLIC
// on-chain object id (suiscan / the gateway /relations index), so anyone who learns it can call the
// paid tool and be served, charged to the victim (theft-of-service / budget-DoS). Proven by
// `scripts/agent-auth-redteam.ts`.
//
// THE FIX — two signatures, both verified off-chain (reuses the consent.ts personal-message scheme):
//   1. BIND CERT — the mandate's `subscriber` (read on-chain) signs "agent address A may operate
//      mandate M (until not_after, version v)". SELF-VERIFYING: presented with calls and re-checked
//      against the on-chain subscriber, so the binding needs no trusted store. Only the real owner
//      can issue it (an attacker can't forge the subscriber's signature).
//   2. CALL PROOF — the agent key signs EACH call over (mandate, usage, merchant, payload, not_after).
//      A public mandateId is no longer enough: you need the agent's private key, and a captured
//      signature can't be replayed (bound to a one-time usageId), reused for a different/larger charge
//      (bound to the payload), or hoarded (bound to not_after).
//
// Pure + isomorphic (only @mysten/sui/verify, like consent.ts): runs in a wallet, a browser, the
// agent runtime, or the service. `MessageSigner` is satisfied by an Ed25519Keypair (or a wallet).
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

/** Bump if a message format changes (old signatures stay verifiable against their own version). */
const BIND_VERSION = 'isub-agent-bind-v1';
const CALL_VERSION = 'isub-call-v1';

/** A subscriber-signed authorization that an agent address may operate a mandate. Self-verifying. */
export interface AgentCert {
  /** The agent's Sui address (derived from the key it signs calls with). */
  agent: string;
  /** Binding expiry (ms epoch); 0n = no expiry. */
  notAfter: bigint;
  /** Monotonic version (key rotation; a verifier rejects a ver lower than one already accepted). */
  ver: number;
  /** The subscriber's personal-message signature over `bindMessage(...)`. */
  sig: string;
}

/** What an agent presents on a call to prove possession. */
export interface CallProof {
  /** The agent key's personal-message signature over `callMessage(...)`. */
  sig: string;
  /** Freshness deadline (ms epoch) — the same value bound into the signed message. */
  notAfter: bigint;
  /** The binding cert (required on first sight; the verifier may cache the bound agent afterwards). */
  cert?: AgentCert;
}

/** Minimal signer shape — an Ed25519Keypair (or a dApp-Kit wallet) satisfies this. */
export interface MessageSigner {
  signPersonalMessage(bytes: Uint8Array): Promise<{ signature: string }>;
  toSuiAddress(): string;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Canonical, deterministic BIND statement the subscriber signs. */
export function bindMessage(p: { mandateId: string; agent: string; notAfter: bigint; ver: number }): string {
  return [BIND_VERSION, `mandate=${p.mandateId}`, `agent=${p.agent}`, `not_after=${p.notAfter}`, `ver=${p.ver}`].join('\n');
}

/** Canonical, deterministic per-call statement the agent signs. */
export function callMessage(p: { mandateId: string; usageId: string; merchant: string; payload: string; notAfter: bigint }): string {
  return [CALL_VERSION, `mandate=${p.mandateId}`, `usage=${p.usageId}`, `merchant=${p.merchant}`, `payload=${p.payload}`, `not_after=${p.notAfter}`].join('\n');
}

/** Bind the call signature to the EXACT charge: a flat amount (`use`) or sorted meter items (`useMetered`). */
export function payloadOf(items?: ReadonlyArray<{ meterKey: string; qty: bigint }>, amount?: bigint): string {
  if (amount != null) return `amount=${amount}`;
  return 'items=' + [...(items ?? [])].map((i) => `${i.meterKey}:${i.qty}`).sort().join(',');
}

async function recoversTo(message: string, signature: string, address: string): Promise<boolean> {
  try {
    const pk = await verifyPersonalMessageSignature(enc(message), signature);
    return pk.toSuiAddress() === address;
  } catch {
    return false;
  }
}

/** The subscriber issues a cert authorizing `agent` for `mandateId`. */
export async function issueAgentCert(
  subscriber: MessageSigner,
  p: { mandateId: string; agent: string; notAfter: bigint; ver: number },
): Promise<AgentCert> {
  const { signature } = await subscriber.signPersonalMessage(enc(bindMessage(p)));
  return { agent: p.agent, notAfter: p.notAfter, ver: p.ver, sig: signature };
}

/** The agent signs one call → returns the per-call proof body (attach the cert at the call site). */
export async function signCall(
  agent: MessageSigner,
  p: { mandateId: string; usageId: string; merchant: string; payload: string; notAfter: bigint },
): Promise<{ sig: string; notAfter: bigint }> {
  const { signature } = await agent.signPersonalMessage(enc(callMessage(p)));
  return { sig: signature, notAfter: p.notAfter };
}

/** Verify a cert: the on-chain `subscriber` actually signed it, and it hasn't expired. */
export async function verifyBinding(mandateId: string, cert: AgentCert, subscriber: string, nowMs: bigint): Promise<boolean> {
  if (cert.notAfter !== 0n && nowMs >= cert.notAfter) return false;
  return recoversTo(bindMessage({ mandateId, agent: cert.agent, notAfter: cert.notAfter, ver: cert.ver }), cert.sig, subscriber);
}

/** Verify a per-call proof: signed by `agent`, still fresh, over EXACTLY this call's message. */
export async function verifyCallProof(message: string, signature: string, agent: string, nowMs: bigint, notAfter: bigint): Promise<boolean> {
  if (nowMs >= notAfter) return false;
  return recoversTo(message, signature, agent);
}

/**
 * Reconstruct a `CallProof` from flat transport fields (an MCP tool's args or an HTTP body) — u64s
 * arrive as numbers/strings, never bigints. Returns undefined when no signature is present (so an
 * unsigned call is gated by the service's `agentAuth` policy, not silently accepted). The single
 * reconstruction point shared by `mcp.ts`, `gateway.ts`, and `service.listen()`.
 */
export function proofFromFields(f: { agentSig?: unknown; agentSigNotAfter?: unknown; agentCert?: unknown }): CallProof | undefined {
  if (typeof f.agentSig !== 'string') return undefined;
  let cert: AgentCert | undefined;
  const c = f.agentCert;
  if (c && typeof c === 'object') {
    const r = c as Record<string, unknown>;
    cert = { agent: String(r.agent), notAfter: BigInt((r.notAfter as number | string) ?? 0), ver: Number(r.ver ?? 0), sig: String(r.sig) };
  }
  return { sig: f.agentSig, notAfter: BigInt((f.agentSigNotAfter as number | string) ?? 0), cert };
}

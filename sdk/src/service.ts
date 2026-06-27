// `IsubService` — the embeddable PAYG service runtime that WIRES the agent's mandate
// to the biller. This is the piece that turns "a pile of verified parts" into "a running
// loop": an agent presents its `mandateId` as a payment credential on each call, the
// service auto-registers it on first sight (validating it's really authorizing THIS
// service), meters usage, gates delivery on remaining budget, and the embedded biller
// settles on-chain per window/threshold.
//
// Decisions (agent-payg-wiring-plan.md, locked 2026-06-16):
//   D1 credential model — `use(mandateId, …)`; first sight validates on-chain + registers.
//   D2 trust the biller's tracked lifecycle (events) for serve/deny — no per-call chain read.
//   D3 flush on window OR pending-threshold; GATE delivery on remaining budget (don't serve
//      value you can't bill) → bounds the uncollectable "over-served" exposure to ~one window.
//   D4 embeddable runtime (any service `new`s it; demo runs one). D6 usage is self-reported.
//   D5 sponsored gas — deferred (charges signed/paid by the service's key for now).
//
// Takes only a `BillerChain` (which `IsubClient` satisfies) → fully unit-testable with a mock.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { IsubSigner } from './signer';
import { IsubBiller, type BillerChain, type BillerEvent, type BillerStore } from './biller';
import { ChargeMode, MandateStatus } from './constants';
import { priceUsageMulti, type RateCard } from './pricing';
import { callMessage, payloadOf, proofFromFields, verifyBinding, verifyCallProof, type CallProof } from './agent-auth';

export interface ServicePolicy {
  /** Background flush cadence (ms). The biller settles every window. */
  windowMs: number;
  /** Also flush a mandate as soon as its un-settled usage crosses this (0 = window-only). */
  flushThresholdAmount?: bigint;
  /**
   * Agent proof-of-possession enforcement — closes the bearer-mandateId hole (see `agent-auth.ts`):
   *   'off'     — no check (back-compat default; existing smokes pass unchanged).
   *   'warn'    — verify; log unsigned/invalid calls but still serve (safe rollout window).
   *   'enforce' — reject any call without a valid agent proof with 403.
   */
  agentAuth?: 'off' | 'warn' | 'enforce';
}

export interface UseResult {
  ok: boolean;
  status: number; // 200 served · 402 not serviceable (gated) · 403 bad credential · 409 duplicate usageId (replay)
  reason?: string;
}

/** Per-mandate serving state (D2: driven by biller lifecycle events, not per-call chain reads). */
interface Session {
  serviceable: boolean;
  /** Optimistic remaining-budget estimate; decremented on meter (conservative — errs to under-serve). */
  remaining: bigint;
  /** Un-settled usage since the last flush (for the D3 threshold). */
  pending: bigint;
  reason?: string;
  /** The on-chain `subscriber` (who may authorize an agent key via a bind cert). Set at first sight. */
  subscriber?: string;
  /** Agent address bound by a verified cert (cached after first valid presentation). */
  boundAgent?: string;
  /** The bound cert's expiry (ms epoch; 0 = none) — re-checked every call so caching can't outlive it. */
  boundNotAfter?: bigint;
  /** Highest cert version accepted (rejects rollback to an older/rotated-out key). */
  boundVer?: number;
}

export class IsubService {
  private readonly biller: IsubBiller;
  private readonly sessions = new Map<string, Session>();
  private readonly validating = new Map<string, Promise<Session>>();
  private readonly windowMs: number;
  private readonly flushThreshold: bigint;
  private readonly agentAuth: 'off' | 'warn' | 'enforce';
  private ac?: AbortController;

  constructor(
    private readonly chain: BillerChain,
    signer: IsubSigner,
    /** The merchant address every accepted mandate must name as payee (usually `signer.address`). */
    private readonly payoutAddress: string,
    private readonly store: BillerStore,
    policy: ServicePolicy,
    private readonly onEvent?: (e: BillerEvent) => void,
    /** The merchant's price list. Required to use `useMetered` (raw-quantity reporting). */
    private readonly rateCard?: RateCard,
  ) {
    this.windowMs = policy.windowMs;
    this.flushThreshold = policy.flushThresholdAmount ?? 0n;
    this.agentAuth = policy.agentAuth ?? 'off';
    this.biller = new IsubBiller(chain, signer, store, {
      rateCard: this.rateCard,
      onEvent: (e) => {
        this.applyEvent(e);
        this.onEvent?.(e);
      },
    });
  }

  /**
   * Agent-facing entry: present the mandate as the payment credential + report this call's
   * usage. Returns 200 (served), 402 (gated — out of budget / not serviceable), or 403 (the
   * mandate isn't a valid credential for this service).
   *
   * `authMode` is the per-ROUTE proof-of-possession policy, set by the TRUSTED server route — NOT
   * from any client/agent payload (or an attacker could send 'off' to bypass). x402 / agent-facing
   * adapters pass 'enforce'; a merchant self-metering its own logged-in users passes 'off'. Omit to
   * fall back to the service default (`policy.agentAuth`). One service / one biller serves both.
   */
  async use(mandateId: string, amount: bigint, usageId: string, proof?: CallProof, authMode?: 'off' | 'warn' | 'enforce'): Promise<UseResult> {
    if (amount <= 0n) return { ok: false, status: 400, reason: 'amount must be positive' };
    const s = await this.session(mandateId);
    if (!s.serviceable) return { ok: false, status: s.reason === 'mandate not for this service' || s.reason === 'not a PAYG mandate' ? 403 : 402, reason: s.reason };
    if (!(await this.authorizeCall(s, mandateId, usageId, payloadOf(undefined, amount), proof, authMode ?? this.agentAuth))) {
      return { ok: false, status: 403, reason: 'agent proof required or invalid (bearer mandateId rejected)' };
    }
    if (s.remaining < amount) return { ok: false, status: 402, reason: 'insufficient remaining budget for this request' };

    // F1: single-use ingest. A duplicate usageId means this call was already served — refuse to
    // re-serve (else a captured/replayed payload yields unlimited free re-serves; funds are safe via
    // dedup but the RESOURCE would be re-delivered). recordUsage is the durable idempotency key.
    if (!(await this.biller.recordUsage({ mandateId, amount, usageId }))) {
      return { ok: false, status: 409, reason: 'duplicate usageId — already served (replay rejected)' };
    }
    s.remaining -= amount;
    s.pending += amount;
    // D3 threshold: settle early when un-settled usage is large (bounds the at-risk window).
    if (this.flushThreshold > 0n && s.pending >= this.flushThreshold) {
      s.pending = 0n;
      // Best-effort early settle: the window loop retries, so a rejection here (transient/lock) must
      // NOT become an unhandled rejection that crashes the service process and takes down every tenant.
      void this.biller.flush(mandateId).catch((e) => console.error('isub service: early flush failed (window loop will retry):', e instanceof Error ? e.message : e));
    }
    return { ok: true, status: 200 };
  }

  /**
   * Like `use`, but the agent reports RAW usage QUANTITIES (one or more meter lines) and the
   * service's RateCard prices them. Requires a card (constructor `rateCard`). The amount is priced
   * once here for the budget gate, then frozen by the biller's `recordMeteredUsage` — both prices
   * are identical (deterministic pure function on the same card + items).
   */
  async useMetered(
    mandateId: string,
    items: ReadonlyArray<{ meterKey: string; qty: bigint }>,
    usageId: string,
    proof?: CallProof,
    authMode?: 'off' | 'warn' | 'enforce',
  ): Promise<UseResult> {
    if (!this.rateCard) return { ok: false, status: 500, reason: 'no rate card configured for this service' };
    let amount: bigint;
    try {
      amount = priceUsageMulti(this.rateCard, items).amount;
    } catch (e) {
      return { ok: false, status: 400, reason: e instanceof Error ? e.message : 'bad usage' };
    }
    if (amount <= 0n) return { ok: false, status: 400, reason: 'priced amount must be positive' };

    const s = await this.session(mandateId);
    if (!s.serviceable) return { ok: false, status: s.reason === 'mandate not for this service' || s.reason === 'not a PAYG mandate' ? 403 : 402, reason: s.reason };
    if (!(await this.authorizeCall(s, mandateId, usageId, payloadOf(items), proof, authMode ?? this.agentAuth))) {
      return { ok: false, status: 403, reason: 'agent proof required or invalid (bearer mandateId rejected)' };
    }
    if (s.remaining < amount) return { ok: false, status: 402, reason: 'insufficient remaining budget for this request' };

    // F1: single-use ingest (see `use`). A duplicate usageId → already served → refuse to re-serve.
    if (!(await this.biller.recordMeteredUsage({ mandateId, items, usageId }))) {
      return { ok: false, status: 409, reason: 'duplicate usageId — already served (replay rejected)' };
    }
    s.remaining -= amount;
    s.pending += amount;
    if (this.flushThreshold > 0n && s.pending >= this.flushThreshold) {
      s.pending = 0n;
      // Best-effort early settle: the window loop retries, so a rejection here (transient/lock) must
      // NOT become an unhandled rejection that crashes the service process and takes down every tenant.
      void this.biller.flush(mandateId).catch((e) => console.error('isub service: early flush failed (window loop will retry):', e instanceof Error ? e.message : e));
    }
    return { ok: true, status: 200 };
  }

  /** Lifecycle view for the merchant (remaining budget estimate + serviceability). */
  status(mandateId: string): { serviceable: boolean; remaining: string; reason?: string } | null {
    const s = this.sessions.get(mandateId);
    return s ? { serviceable: s.serviceable, remaining: s.remaining.toString(), reason: s.reason } : null;
  }

  /**
   * Forget the cached session so the next `use()`/`useMetered()` re-validates from chain. Needed
   * because a session that went non-serviceable on a RECOVERABLE event (e.g. `insufficient_balance`
   * when the Account ran dry) would otherwise stay dead for the life of the process — a caller that
   * keeps retrying after the subscriber tops up must evict to pick the funds back up.
   */
  evict(mandateId: string): void {
    this.sessions.delete(mandateId);
  }

  /**
   * Agent proof-of-possession gate (closes the bearer-mandateId hole). 'off' → always allow; 'warn'
   * → verify + log but allow; 'enforce' → only a valid proof passes. `payload` binds the signature to
   * THIS exact charge (amount or sorted meter items) so a captured signature can't be reused.
   */
  private async authorizeCall(s: Session, mandateId: string, usageId: string, payload: string, proof: CallProof | undefined, mode: 'off' | 'warn' | 'enforce'): Promise<boolean> {
    if (mode === 'off') return true;
    if (await this.verifyProof(s, mandateId, usageId, payload, proof)) return true;
    if (mode === 'warn') {
      console.warn(`[isub] agent-auth WARN: missing/invalid proof on ${mandateId} (usage ${usageId}) — would be 403 in enforce mode`);
      return true;
    }
    return false;
  }

  private async verifyProof(s: Session, mandateId: string, usageId: string, payload: string, proof?: CallProof): Promise<boolean> {
    if (!proof || typeof proof.sig !== 'string' || proof.notAfter == null) return false;
    const now = BigInt(Date.now());
    // A presented cert (re)establishes the bound agent — re-verified against the on-chain subscriber,
    // so the binding is self-verifying (no trusted store). Cached on the session after first sight.
    if (proof.cert) {
      if (!s.subscriber || !(await verifyBinding(mandateId, proof.cert, s.subscriber, now))) return false;
      // F5: rollback protection must be DURABLE (survive restart / hold across instances), not just the
      // in-memory session. Floor the accepted ver by max(session, durable store) and reject anything
      // below it (a rotated-out / leaked older key), then persist any advance so peers see it too.
      const durableVer = await this.store.getMaxCertVer?.(mandateId);
      const floor = s.boundVer == null ? durableVer : durableVer == null ? s.boundVer : Math.max(s.boundVer, durableVer);
      if (floor != null && proof.cert.ver < floor) return false; // rollback to a rotated-out key
      s.boundAgent = proof.cert.agent;
      s.boundVer = floor == null ? proof.cert.ver : Math.max(floor, proof.cert.ver);
      if (durableVer == null || proof.cert.ver > durableVer) await this.store.recordCertVer?.(mandateId, proof.cert.ver);
      // Take the LATER expiry (0 = never) so a concurrent/older cert can't shrink the live session.
      const cn = proof.cert.notAfter;
      s.boundNotAfter = s.boundNotAfter == null ? cn : s.boundNotAfter === 0n || cn === 0n ? 0n : cn > s.boundNotAfter ? cn : s.boundNotAfter;
    }
    if (!s.boundAgent) return false; // no binding ever presented → bearer call, reject
    if (s.boundNotAfter != null && s.boundNotAfter !== 0n && now >= s.boundNotAfter) return false; // cached binding expired
    const msg = callMessage({ mandateId, usageId, merchant: this.payoutAddress, payload, notAfter: proof.notAfter });
    return verifyCallProof(msg, proof.sig, s.boundAgent, now, proof.notAfter);
  }

  /** First sight of a mandate → validate on-chain that it authorizes THIS service, then register. */
  private async session(mandateId: string): Promise<Session> {
    const existing = this.sessions.get(mandateId);
    if (existing) return existing;
    const inflight = this.validating.get(mandateId);
    if (inflight) return inflight;

    const p = (async (): Promise<Session> => {
      const s: Session = { serviceable: false, remaining: 0n, pending: 0n };
      try {
        const m = await this.chain.getMandate(mandateId);
        s.subscriber = m.subscriber; // who may authorize an agent key (bind-cert issuer)
        if (m.merchant !== this.payoutAddress) s.reason = 'mandate not for this service';
        else if (m.mode !== ChargeMode.Payg) s.reason = 'not a PAYG mandate';
        else if (m.status !== MandateStatus.Active) s.reason = 'mandate not active';
        else if (BigInt(Date.now()) >= m.expiryMs) s.reason = 'mandate expired';
        else {
          s.serviceable = true;
          s.remaining = m.totalBudget > m.spentTotal ? m.totalBudget - m.spentTotal : 0n;
        }
      } catch (e) {
        s.reason = e instanceof Error ? e.message : String(e);
      }
      this.sessions.set(mandateId, s);
      this.validating.delete(mandateId);
      return s;
    })();
    this.validating.set(mandateId, p);
    return p;
  }

  /** D2: drive serviceability off the biller's lifecycle events (no per-call chain read). */
  private applyEvent(e: BillerEvent): void {
    const s = this.sessions.get(e.mandateId);
    if (!s) return;
    if (e.type === 'budget.exhausted' || e.type === 'mandate.expired') {
      s.serviceable = false;
      s.reason = e.type;
    } else if (e.type === 'usage.carried' && (e.reason === 'insufficient_balance' || e.reason === 'budget_exhausted' || e.reason === 'not_billable')) {
      s.serviceable = false; // account dry / budget hit / revoked-paused-expired → stop serving
      s.reason = e.reason;
    } else if (e.type === 'charge.failed' && e.abortCode === 4) {
      s.serviceable = false; // ENotActive (defensive; the biller usually carries 'not_billable' first)
      s.reason = 'not_billable';
    }
  }

  /** Start the background window-flush loop. Idempotent-ish; call once. */
  start(): void {
    if (this.ac) return;
    this.ac = new AbortController();
    void this.biller.run({ pollMs: this.windowMs, signal: this.ac.signal });
  }
  async stop(): Promise<void> {
    this.ac?.abort();
    this.ac = undefined;
    await this.biller.close();
  }

  /** Settle now (all mandates with un-settled usage). Exposed for tests / manual flush. */
  flush(mandateId?: string): Promise<import('./biller').FlushResult[]> {
    return this.biller.flush(mandateId);
  }

  /**
   * Thin HTTP front: `POST /use` with `x-isub-mandate: <id>` header + body `{ amount, usageId }`.
   * SECURE BY DEFAULT: this is an agent-facing network door, so it ENFORCES the agent PoP (a bearer
   * mandateId with no proof → 403) unless the operator passes `{ authMode: 'off' }` for a merchant
   * self-metering its own already-authenticated users. (The in-process `use()` primitive keeps its
   * permissive default so a trusted route picks its own mode; only the network DOOR fails closed.)
   * Production services would fold `use()` into their own business endpoint instead.
   */
  listen(port: number, opts: { authMode?: 'off' | 'warn' | 'enforce' } = {}): Server {
    const authMode = opts.authMode ?? 'enforce';
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/use')) {
        res.statusCode = 404;
        return res.end();
      }
      const mandateId = req.headers['x-isub-mandate'];
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          if (typeof mandateId !== 'string') {
            res.statusCode = 400;
            return res.end(JSON.stringify({ ok: false, reason: 'missing x-isub-mandate header' }));
          }
          const parsed = JSON.parse(body || '{}') as { amount: string; usageId: string; agentSig?: unknown; agentSigNotAfter?: unknown; agentCert?: unknown };
          const r = await this.use(mandateId, BigInt(parsed.amount), String(parsed.usageId), proofFromFields(parsed), authMode);
          res.statusCode = r.status;
          res.end(JSON.stringify(r));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
        }
      });
    });
    server.listen(port);
    return server;
  }
}

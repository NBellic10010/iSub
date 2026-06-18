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

export interface ServicePolicy {
  /** Background flush cadence (ms). The biller settles every window. */
  windowMs: number;
  /** Also flush a mandate as soon as its un-settled usage crosses this (0 = window-only). */
  flushThresholdAmount?: bigint;
}

export interface UseResult {
  ok: boolean;
  status: number; // 200 served · 402 not serviceable (gated) · 403 bad credential
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
}

export class IsubService {
  private readonly biller: IsubBiller;
  private readonly sessions = new Map<string, Session>();
  private readonly validating = new Map<string, Promise<Session>>();
  private readonly windowMs: number;
  private readonly flushThreshold: bigint;
  private ac?: AbortController;

  constructor(
    private readonly chain: BillerChain,
    signer: IsubSigner,
    /** The merchant address every accepted mandate must name as payee (usually `signer.address`). */
    private readonly payoutAddress: string,
    store: BillerStore,
    policy: ServicePolicy,
    private readonly onEvent?: (e: BillerEvent) => void,
    /** The merchant's price list. Required to use `useMetered` (raw-quantity reporting). */
    private readonly rateCard?: RateCard,
  ) {
    this.windowMs = policy.windowMs;
    this.flushThreshold = policy.flushThresholdAmount ?? 0n;
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
   */
  async use(mandateId: string, amount: bigint, usageId: string): Promise<UseResult> {
    if (amount <= 0n) return { ok: false, status: 400, reason: 'amount must be positive' };
    const s = await this.session(mandateId);
    if (!s.serviceable) return { ok: false, status: s.reason === 'mandate not for this service' || s.reason === 'not a PAYG mandate' ? 403 : 402, reason: s.reason };
    if (s.remaining < amount) return { ok: false, status: 402, reason: 'insufficient remaining budget for this request' };

    await this.biller.recordUsage({ mandateId, amount, usageId });
    s.remaining -= amount;
    s.pending += amount;
    // D3 threshold: settle early when un-settled usage is large (bounds the at-risk window).
    if (this.flushThreshold > 0n && s.pending >= this.flushThreshold) {
      s.pending = 0n;
      void this.biller.flush(mandateId); // non-blocking; biller single-flight serializes vs the window loop
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
    if (s.remaining < amount) return { ok: false, status: 402, reason: 'insufficient remaining budget for this request' };

    await this.biller.recordMeteredUsage({ mandateId, items, usageId });
    s.remaining -= amount;
    s.pending += amount;
    if (this.flushThreshold > 0n && s.pending >= this.flushThreshold) {
      s.pending = 0n;
      void this.biller.flush(mandateId); // non-blocking; biller single-flight serializes vs the window loop
    }
    return { ok: true, status: 200 };
  }

  /** Lifecycle view for the merchant (remaining budget estimate + serviceability). */
  status(mandateId: string): { serviceable: boolean; remaining: string; reason?: string } | null {
    const s = this.sessions.get(mandateId);
    return s ? { serviceable: s.serviceable, remaining: s.remaining.toString(), reason: s.reason } : null;
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
  flush(mandateId?: string): Promise<unknown> {
    return this.biller.flush(mandateId);
  }

  /**
   * Thin HTTP front: `POST /use` with `x-isub-mandate: <id>` header + body `{ amount, usageId }`.
   * Production services would fold `use()` into their own business endpoint instead.
   */
  listen(port: number): Server {
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
          const { amount, usageId } = JSON.parse(body || '{}') as { amount: string; usageId: string };
          const r = await this.use(mandateId, BigInt(amount), String(usageId));
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

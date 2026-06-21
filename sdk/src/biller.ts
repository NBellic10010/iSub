// `IsubBiller` — the supply-side PAYG settlement pipeline (the service/merchant that
// METERS usage and pulls `charge_metered` within a mandate's caps). Complements
// `./agent` (the demand side that authorizes mandates).
//
// Pipeline: recordUsage (idempotent ingest, dedup by usageId) → accumulate off-chain →
// flush (per-mandate SINGLE-FLIGHT: clamp to spendable, charge within caps, carry the
// rest). Aggregating keeps micro-metering viable on-chain (one settlement per window,
// not one tx per call).
//
// MONEY-CORRECTNESS (G1: bill each record at most once, even across lost acks / crashes):
// a charge that lands on-chain advances `charge_seq` irreversibly, but the off-chain
// "mark billed" can't be atomic with it. So before every charge the biller RECONCILES:
// if the journal has a `submit` at seq S with no matching `charged` AND the on-chain
// charge_seq has moved past S, that submit LANDED — its records are marked billed (a
// `charged` entry is back-filled) instead of charging again. Reconcile runs at the top
// of every attempt, closing both the cross-flush crash gap and the in-loop delayed-ack
// race. Assumes ONE biller per mandate (enforced by the store lock).
//
// Depends only on a narrow `BillerChain` (which `IsubClient` satisfies) + a `BillerStore`
// (mem for tests, SQL for prod) → the whole pipeline is unit-testable with no chain.
import { ChargeMode, MandateStatus } from './constants';
import type { MandateState, AccountState } from './types';
import type { IsubSigner } from './signer';
import { IsubAbortError, IsubError } from './errors';
import type { JournalEntry } from './store';
import { priceUsageMulti, assertValidRateCard, type RateCard } from './pricing';

const E_BAD_SEQ = 20;
const E_OVER_RATE_CAP = 8;
const E_OVER_BUDGET = 9;
const E_INSUFFICIENT = 10;
const E_OVER_PER_CHARGE = 24;
const E_NOT_BEFORE = 6; // EIntervalNotElapsed — PAYG charge attempted before not_before_ms (chain Clock)

/**
 * Clock-skew tolerance (ms) for the not_before pre-flight. `not_before_ms` is set from the CHAIN
 * Clock at authorize, but `spendableNow` compares it to the LOCAL wall clock. Without slack, a
 * sub-second local-behind-chain skew makes the FIRST charge of a no-delay mandate (where
 * not_before ≈ authorize time) false-skip — spendable reads 0 and the charge silently carries
 * instead of settling (observed on testnet: a flush ~1s after authorize dropped the first charge).
 * The chain re-enforces not_before authoritatively, so erring a few seconds early is safe: for a
 * no-delay mandate the chain always accepts (chain-now ≥ not_before post-authorize); only at a real
 * future trial boundary could it abort #6, which settle() now treats as a non-fatal carry.
 */
const NOT_BEFORE_SKEW_MS = 5_000;

export interface UsageRow {
  usageId: string;
  mandateId: string;
  /** The FROZEN charge for this record (priced once at ingest). Settle/recoverOrphan read ONLY this. */
  amount: bigint;
  atMs: number;
  // Provenance (audit only; NEVER a billing input) — set by the priced `recordMeteredUsage` path.
  /** The meter this was priced on ('multi' when >1 meter line). */
  meterKey?: string;
  /** Reported quantity (undefined for a multi-meter record). */
  qty?: bigint;
  /** RateCard.version this was priced against. */
  rateCardVersion?: number;
}

/**
 * Persistence for usage records + the charge journal. `recordUsage` returns false on a
 * duplicate usageId. Optional `acquireLock`/`releaseLock` give cross-instance single-flight
 * (so two biller processes can't bill the same mandate set) — implement them in production.
 */
export interface BillerStore {
  recordUsage(u: UsageRow): Promise<boolean>;
  unbilled(mandateId: string): Promise<UsageRow[]>;
  markBilled(usageIds: string[]): Promise<void>;
  mandatesWithUnbilled(): Promise<string[]>;
  appendJournal(e: JournalEntry): Promise<void>;
  readJournal(): Promise<JournalEntry[]>;
  acquireLock?(): Promise<void>;
  /** Refresh our heartbeat; throw if we've been superseded (so run() can stand down). */
  renewLock?(): Promise<void>;
  releaseLock?(): Promise<void>;
}

/** The slice of `IsubClient` the biller needs — so a faithful mock can stand in for the chain. */
export interface BillerChain {
  getMandate(id: string): Promise<MandateState>;
  getAccount(id: string): Promise<AccountState>;
  chargeMetered(signer: IsubSigner, p: { accountId: string; mandateId: string; amount: bigint; seq: bigint }): Promise<{ digest: string }>;
}

export type CarryReason = 'budget_exhausted' | 'rate_limited' | 'insufficient_balance' | 'per_charge_too_small' | 'not_billable';

export type BillerEvent =
  | { type: 'charge.succeeded'; mandateId: string; at: number; amount: bigint; digest: string; seq: number }
  | { type: 'charge.failed'; mandateId: string; at: number; error: string; deterministic: boolean; abortCode: number | null }
  | { type: 'usage.carried'; mandateId: string; at: number; amount: bigint; reason: CarryReason }
  | { type: 'budget.threshold'; mandateId: string; at: number; pct: number }
  | { type: 'budget.exhausted'; mandateId: string; at: number }
  | { type: 'mandate.expired'; mandateId: string; at: number };

export interface FlushResult {
  mandateId: string;
  charged: bigint;
  carried: bigint;
  digest?: string;
  reason?: CarryReason | 'charged' | 'skipped';
}

export interface BillerPolicy {
  /** Emit `budget.threshold` once spent crosses this % of total_budget (default 80; 0 disables). */
  thresholdPct?: number;
  /** Max attempts per flush (re-read + shrink/recover on contention/over-cap). Default 5. */
  maxRetries?: number;
  /** Max mandates settled CONCURRENTLY per flush — bounds RPC fan-out so a large book can't storm
   *  the node / self-DoS. Default 8. */
  concurrency?: number;
  /** Lock-heartbeat interval (ms) used by `run()`, INDEPENDENT of pollMs/backoff. Keep it well below
   *  the store's lease TTL (sqlBillerStore: 120s) or the lock self-expires into split-brain. Default 40_000. */
  leaseRenewMs?: number;
}

/** Sleep `ms`, but resolve EARLY if `signal` aborts — so an aborted run loop stops promptly instead
 *  of waiting out a full poll/backoff interval (up to 60s). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (a < b ? a : b));

/** Run `fn` over `items` with at most `limit` concurrent calls, preserving result order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()));
  return results;
}

/**
 * How much can be pulled from this mandate RIGHT NOW = min(remaining budget, remaining
 * rate-window, per-charge cap, account balance) — 0 if paused/revoked/expired or before
 * the first-charge window. The chain re-enforces all of this; this only avoids gas on aborts.
 */
export function spendableNow(m: MandateState, accountBalance: bigint, nowMs: number): bigint {
  const now = BigInt(nowMs);
  if (m.status !== MandateStatus.Active) return 0n;
  // not_before is in CHAIN time; we compare against the local clock → allow a skew tolerance so a
  // sub-second local-behind-chain skew can't false-skip the first charge (the chain re-enforces it).
  if (now >= m.expiryMs || now + BigInt(NOT_BEFORE_SKEW_MS) < m.notBeforeMs) return 0n;
  const budgetLeft = m.totalBudget > m.spentTotal ? m.totalBudget - m.spentTotal : 0n;
  const windowLeft = now >= m.windowStartMs + m.rateWindowMs ? m.rateCap : m.rateCap > m.windowSpent ? m.rateCap - m.windowSpent : 0n;
  return min(budgetLeft, windowLeft, m.maxPerCharge, accountBalance);
}

export class IsubBiller {
  private readonly thresholdPct: number;
  private readonly maxRetries: number;
  private readonly concurrency: number;
  private readonly leaseRenewMs: number;
  private readonly inflight = new Map<string, Promise<unknown>>(); // per-mandate in-process serialization
  private readonly thresholdFired = new Set<string>();
  private readonly onEvent?: (e: BillerEvent) => void;
  /** Optional merchant price list. When set, `recordMeteredUsage` prices raw quantities against it. */
  private readonly rateCard?: RateCard;
  private initialized = false;

  constructor(
    private readonly chain: BillerChain,
    private readonly signer: IsubSigner,
    private readonly store: BillerStore,
    opts: { policy?: BillerPolicy; onEvent?: (e: BillerEvent) => void; rateCard?: RateCard } = {},
  ) {
    this.thresholdPct = opts.policy?.thresholdPct ?? 80;
    this.maxRetries = opts.policy?.maxRetries ?? 5;
    this.concurrency = Math.max(1, opts.policy?.concurrency ?? 8);
    this.leaseRenewMs = opts.policy?.leaseRenewMs ?? 40_000;
    this.onEvent = opts.onEvent;
    if (opts.rateCard) assertValidRateCard(opts.rateCard); // malformed card fails at startup, not at ingest
    this.rateCard = opts.rateCard;
  }

  /** Take the cross-instance billing lock (if the store provides one). Lazy-called by flush. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.acquireLock?.();
    this.initialized = true;
  }
  /** Release the lock. No-op if we never acquired it — so a failed/contended start never frees
   *  (deletes) a DIFFERENT live instance's lock. */
  async close(): Promise<void> {
    if (!this.initialized) return;
    await this.store.releaseLock?.();
  }

  private emit(e: BillerEvent): void {
    try {
      this.onEvent?.(e);
    } catch {
      /* listener errors never break billing */
    }
  }

  /** Idempotent ingest: dedups by usageId, accumulates off-chain. A retried report is a no-op. */
  async recordUsage(u: { mandateId: string; amount: bigint; usageId: string; atMs?: number }): Promise<void> {
    if (u.amount <= 0n) throw new IsubError('usage', 'usage amount must be positive');
    await this.store.recordUsage({ usageId: u.usageId, mandateId: u.mandateId, amount: u.amount, atMs: u.atMs ?? Date.now() });
  }

  /**
   * Priced ingest: report RAW quantities (1+ meter lines under ONE usageId); the RateCard prices
   * them ONCE here, freezes the bigint, and feeds the SAME `recordUsage` dedup path. The card is
   * never read again — settle/recoverOrphan see only the frozen `amount`, so a later card edit can
   * never re-price this record. A retried report (same usageId) is a no-op and is NOT re-priced.
   */
  async recordMeteredUsage(u: {
    mandateId: string;
    usageId: string;
    items: ReadonlyArray<{ meterKey: string; qty: bigint }>;
    atMs?: number;
  }): Promise<void> {
    if (!this.rateCard) throw new IsubError('config', 'no rate card configured on this biller');
    const { amount, lines, cardVersion } = priceUsageMulti(this.rateCard, u.items); // price once, freeze
    if (amount <= 0n) throw new IsubError('usage', 'priced amount must be positive'); // never store an un-billable phantom row
    await this.store.recordUsage({
      usageId: u.usageId,
      mandateId: u.mandateId,
      amount,
      atMs: u.atMs ?? Date.now(),
      meterKey: lines.length === 1 ? lines[0]!.meterKey : 'multi',
      qty: lines.length === 1 ? lines[0]!.qty : undefined,
      rateCardVersion: cardVersion,
    });
  }

  /** What this mandate can be charged right now (the pre-flight ceiling). */
  async spendable(mandateId: string): Promise<bigint> {
    const m = await this.chain.getMandate(mandateId);
    const acct = await this.chain.getAccount(m.accountId);
    return spendableNow(m, acct.balance, Date.now());
  }

  /** Settle one mandate (or all with unbilled usage). Per-mandate single-flight. */
  async flush(mandateId?: string, nowMs: number = Date.now()): Promise<FlushResult[]> {
    await this.init();
    const ids = mandateId ? [mandateId] : await this.store.mandatesWithUnbilled();
    // A5: bound concurrent settles so a large book can't fan out into an RPC storm / self-DoS.
    // A2: ISOLATE each mandate — one mandate's settle failure (an unreadable/closed mandate, a
    // lost-ack commit, …) must NOT reject the whole batch nor be retried-forever as a batch failure.
    // It becomes its own failure FlushResult + a charge.failed event (mirrors the keeper's K-1).
    return mapWithConcurrency(ids, this.concurrency, (id) =>
      this.flushOne(id, nowMs).catch((e): FlushResult => {
        const error = e instanceof Error ? e.message : String(e);
        const abortCode = e instanceof IsubAbortError ? e.abortCode : null;
        this.emit({ type: 'charge.failed', mandateId: id, at: nowMs, error, deterministic: abortCode !== null, abortCode });
        return { mandateId: id, charged: 0n, carried: 0n, reason: undefined };
      }),
    );
  }

  private flushOne(mandateId: string, nowMs: number): Promise<FlushResult> {
    const prev = this.inflight.get(mandateId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.settle(mandateId, nowMs));
    this.inflight.set(mandateId, next);
    // A3 (biller-special-review): drop the entry once this settle finishes, so a long-running biller
    // covering many distinct mandates doesn't accumulate resolved Promises forever (each pins the
    // settle closure → chain/store/signer). Guard on identity: only delete if we're still the chain
    // tail (a newer flushOne may have already chained on us). The `.catch` swallows THIS branch only —
    // the caller still receives `next` and handles its rejection; we must not raise a second, unhandled one.
    void next
      .finally(() => {
        if (this.inflight.get(mandateId) === next) this.inflight.delete(mandateId);
      })
      .catch(() => {});
    return next;
  }

  /** Number of mandates with an in-flight (or just-chained) settle — for tests/observability. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  private async settle(mandateId: string, nowMs: number): Promise<FlushResult> {
    let totalCharged = 0n;
    let carried = 0n;
    let lastFailure: { error: string; code: number | null } | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      // (0) Reconcile any landed-but-unrecorded prior charge BEFORE new billing — closes the
      //     lost-ack / crash double-charge gap. Marks those records billed; never re-charges.
      totalCharged += await this.recoverOrphan(mandateId, nowMs);

      const unbilled = await this.store.unbilled(mandateId);
      if (unbilled.length === 0) {
        return { mandateId, charged: totalCharged, carried: 0n, reason: totalCharged > 0n ? 'charged' : 'skipped' };
      }
      carried = unbilled.reduce((s, r) => s + r.amount, 0n);

      const m = await this.chain.getMandate(mandateId);
      if (m.mode !== ChargeMode.Payg) return { mandateId, charged: totalCharged, carried, reason: 'not_billable' };
      if (BigInt(nowMs) >= m.expiryMs) {
        this.emit({ type: 'mandate.expired', mandateId, at: nowMs });
        return { mandateId, charged: totalCharged, carried, reason: 'not_billable' };
      }
      if (m.status !== MandateStatus.Active) {
        // Revoked/paused — can't bill (chain would abort #4 anyway). Signal it clearly so the
        // service stops serving, instead of falling through to a misleading 'rate_limited' carry.
        this.emitCarry(mandateId, carried, 'not_billable', nowMs);
        return { mandateId, charged: totalCharged, carried, reason: 'not_billable' };
      }
      const acct = await this.chain.getAccount(m.accountId);
      const spendable = spendableNow(m, acct.balance, nowMs);

      // Greedily take whole records (oldest first) up to `spendable`; the rest carries.
      const batch: UsageRow[] = [];
      let sum = 0n;
      for (const r of unbilled) {
        if (sum + r.amount > spendable) break;
        batch.push(r);
        sum += r.amount;
      }
      if (sum === 0n) {
        const reason = carryReason(m, acct.balance, unbilled[0]!.amount, nowMs);
        this.emitCarry(mandateId, carried, reason, nowMs);
        return { mandateId, charged: totalCharged, carried, reason };
      }

      const seq = m.chargeSeq;
      // Record the EXACT batch membership so recoverOrphan marks the right records billed
      // (not an amount-matched prefix of the then-current unbilled set).
      await this.store.appendJournal({ at: nowMs, mandateId, kind: 'submit', amount: sum.toString(), seq: Number(seq), usageIds: batch.map((r) => r.usageId) });
      try {
        const { digest } = await this.chain.chargeMetered(this.signer, { accountId: m.accountId, mandateId, amount: sum, seq });
        // Charge landed. Commit OUTSIDE the abort-handling try: a markBilled/journal failure
        // here means the charge LANDED but wasn't recorded → an orphan the next attempt's
        // recoverOrphan repairs, NOT a charge failure. Let it propagate.
        await this.commitCharge(mandateId, batch, sum, Number(seq) + 1, digest, nowMs, m);
        totalCharged += sum;
        if (sum === carried) return { mandateId, charged: totalCharged, carried: 0n, digest, reason: 'charged' };
        continue; // more pending (rate/per-charge limited) → next attempt
      } catch (e) {
        const code = e instanceof IsubAbortError ? e.abortCode : null;
        if (code === E_OVER_RATE_CAP || code === E_OVER_BUDGET || code === E_OVER_PER_CHARGE) {
          continue; // abort ⇒ nothing landed (rollback); re-read, shrink batch next attempt
        }
        if (code === E_INSUFFICIENT) {
          this.emitCarry(mandateId, carried, 'insufficient_balance', nowMs);
          return { mandateId, charged: totalCharged, carried, reason: 'insufficient_balance' };
        }
        if (code === E_NOT_BEFORE) {
          // Charged just before not_before (a real future-trial boundary, within the skew window the
          // pre-flight allows). Nothing landed; it's simply not chargeable YET — carry as NON-FATAL
          // (keep serving the trial) and let the next window settle it. Not a charge.failed.
          this.emitCarry(mandateId, carried, 'rate_limited', nowMs);
          return { mandateId, charged: totalCharged, carried, reason: 'rate_limited' };
        }
        // EBadChargeSeq OR transient (non-abort): the charge MAY have landed. Don't re-derive a
        // fresh seq here — the next attempt's recoverOrphan resolves it from the chain seq.
        lastFailure = { error: e instanceof Error ? e.message : String(e), code };
        continue;
      }
    }
    // Retries exhausted. A lingering non-abort failure (RPC down) is a real failure to surface;
    // otherwise it's sustained rate/contention and the rest simply carries.
    if (lastFailure) {
      await this.store.appendJournal({ at: nowMs, mandateId, kind: 'fail', reason: lastFailure.error });
      this.emit({ type: 'charge.failed', mandateId, at: nowMs, error: lastFailure.error, deterministic: lastFailure.code !== null, abortCode: lastFailure.code });
      return { mandateId, charged: totalCharged, carried, reason: undefined };
    }
    this.emitCarry(mandateId, carried, 'rate_limited', nowMs);
    return { mandateId, charged: totalCharged, carried, reason: totalCharged > 0n ? 'charged' : 'rate_limited' };
  }

  /**
   * Reconcile landed-but-unrecorded charges. A prior `submit` at seq S whose `charged` is
   * missing AND whose seq < the on-chain charge_seq LANDED (single-charger invariant) but
   * wasn't recorded. Mark EXACTLY that submit's recorded `usageIds` billed + back-fill a
   * `charged` entry — membership is authoritative, never reconstructed by amount. (The old
   * amount-matched-prefix reconstruction could mark the WRONG records billed when a later /
   * reordered record made a different prefix sum to the same total — leaving the truly-billed
   * records "unbilled" and re-charged on the next flush, i.e. a double-charge.) Processes ALL
   * outstanding orphans oldest-first; returns the total recovered (0 if none).
   */
  private async recoverOrphan(mandateId: string, nowMs: number): Promise<bigint> {
    const mine = (await this.store.readJournal()).filter((e) => e.mandateId === mandateId && e.seq != null);
    const settledSubmitSeqs = new Set(mine.filter((e) => e.kind === 'charged').map((e) => e.seq! - 1));
    // Among MULTIPLE submits at the same seq (a cap-abort / transient that did NOT advance the chain,
    // then a retry re-submitting at that same seq), only the LAST one could have landed: any earlier
    // landing would have advanced charge_seq, forcing the next submit to a higher seq (and settle()
    // runs recoverOrphan at the top of every attempt, so a landed-but-lost-ack submit is recovered
    // BEFORE the next submit). So collapse to the last submit per unsettled seq — recovering an
    // earlier same-seq submit would mark the wrong records billed AND double-count the ledger. This
    // correctness relies on the single-biller invariant the store lock enforces (see renewLock).
    const lastSubmitBySeq = new Map<number, JournalEntry>();
    for (const e of mine) {
      if (e.kind === 'submit' && !settledSubmitSeqs.has(e.seq!)) lastSubmitBySeq.set(e.seq!, e); // later wins
    }
    const orphans = [...lastSubmitBySeq.values()].sort((a, b) => a.seq! - b.seq!);
    if (orphans.length === 0) return 0n;

    const chainSeq = Number((await this.chain.getMandate(mandateId)).chargeSeq);
    let recovered = 0n;
    for (const orphan of orphans) {
      if (chainSeq <= orphan.seq!) continue; // this submit did NOT land — normal flow re-charges it
      if (!orphan.usageIds || orphan.amount == null) {
        // Legacy submit predating membership recording: cannot safely map the landed charge to
        // records (amount-matching is the very bug this removed). Surface for manual reconcile.
        await this.store.appendJournal({ at: nowMs, mandateId, kind: 'fail', reason: `recover: landed submit seq=${orphan.seq} has no recorded usageIds — manual reconcile` });
        continue;
      }
      await this.store.markBilled(orphan.usageIds); // exactly the records this charge covered
      const amt = BigInt(orphan.amount);
      await this.store.appendJournal({ at: nowMs, mandateId, kind: 'charged', amount: orphan.amount, seq: orphan.seq! + 1, reason: 'recovered' });
      this.emit({ type: 'charge.succeeded', mandateId, at: nowMs, amount: amt, digest: 'recovered', seq: orphan.seq! + 1 });
      recovered += amt;
    }
    return recovered;
  }

  private async commitCharge(mandateId: string, batch: UsageRow[], sum: bigint, newSeq: number, digest: string | undefined, nowMs: number, m: MandateState): Promise<void> {
    await this.store.markBilled(batch.map((r) => r.usageId));
    await this.store.appendJournal({ at: nowMs, mandateId, kind: 'charged', amount: sum.toString(), seq: newSeq, digest });
    this.emit({ type: 'charge.succeeded', mandateId, at: nowMs, amount: sum, digest: digest ?? 'recovered', seq: newSeq });
    this.maybeThreshold(mandateId, m.spentTotal + sum, m.totalBudget, nowMs);
  }

  private emitCarry(mandateId: string, amount: bigint, reason: CarryReason, nowMs: number): void {
    if (amount <= 0n) return;
    this.emit({ type: 'usage.carried', mandateId, at: nowMs, amount, reason });
    if (reason === 'budget_exhausted') this.emit({ type: 'budget.exhausted', mandateId, at: nowMs });
  }

  private maybeThreshold(mandateId: string, spent: bigint, budget: bigint, nowMs: number): void {
    if (this.thresholdPct <= 0 || budget === 0n || this.thresholdFired.has(mandateId)) return;
    const pct = Number((spent * 100n) / budget);
    if (pct >= this.thresholdPct) {
      this.thresholdFired.add(mandateId);
      this.emit({ type: 'budget.threshold', mandateId, at: nowMs, pct });
    }
  }

  /** Poll: flush all mandates with unbilled usage every `pollMs` until aborted. */
  async run(opts: { pollMs: number; signal?: AbortSignal; onTick?: (r: FlushResult[]) => void }): Promise<void> {
    // Fail-fast: take the lock BEFORE the loop so contention is terminal (don't spin retrying it).
    await this.init();
    // B4: heartbeat on an INDEPENDENT cadence (leaseRenewMs ≪ the store's lease TTL), decoupled from
    // pollMs/backoff — so a long poll window or a backoff sleep can never starve the renewal and let
    // the lock self-expire into split-brain. A renew that finds us superseded flags the loop to stand down.
    let lost: unknown = null;
    const beat = this.store.renewLock
      ? setInterval(() => void this.store.renewLock!().catch((e) => (lost = e)), this.leaseRenewMs)
      : undefined;
    try {
      let backoffMs = 0;
      while (!opts.signal?.aborted && !lost) {
        try {
          const r = await this.flush();
          backoffMs = 0;
          // onTick is a listener: AWAIT it (so an async listener's rejection can't escape as an
          // unhandledRejection) and ISOLATE it (its failure must never affect billing or backoff).
          if (opts.onTick) {
            try {
              await opts.onTick(r);
            } catch (e) {
              console.error('biller: onTick listener threw (ignored):', e instanceof Error ? e.message : e);
            }
          }
        } catch (e) {
          // A lock error (contended / superseded mid-run) is TERMINAL — stand down, don't double-bill.
          if (e instanceof IsubError && e.code === 'lock') throw e;
          backoffMs = Math.min(backoffMs > 0 ? backoffMs * 2 : opts.pollMs * 2, 60_000); // transient → back off
          console.error(`biller: tick failed (retry in ${backoffMs}ms):`, e instanceof Error ? e.message : e);
        }
        await sleep(backoffMs > 0 ? backoffMs : opts.pollMs, opts.signal); // interruptible: abort wakes it
      }
      if (lost) throw lost; // heartbeat saw us superseded → terminal stand-down (don't keep billing)
    } finally {
      if (beat) clearInterval(beat);
      await this.close(); // always release the lock — even on the terminal lock-loss throw above
    }
  }
}

/** Why a (sub-spendable) charge couldn't be made — for the carried event. Uses the just-read mandate. */
function carryReason(m: MandateState, balance: bigint, firstRecord: bigint, nowMs: number): CarryReason {
  const now = BigInt(nowMs);
  if (m.spentTotal >= m.totalBudget) return 'budget_exhausted';
  if (now < m.windowStartMs + m.rateWindowMs && m.windowSpent >= m.rateCap) return 'rate_limited';
  if (balance < firstRecord || balance === 0n) return 'insufficient_balance';
  if (firstRecord > m.maxPerCharge) return 'per_charge_too_small';
  return 'rate_limited';
}

// ===== in-memory BillerStore (tests/demos; SQL impl is `sqlBillerStore` in ./sql-store) =====

export function memBillerStore(): BillerStore {
  const usage: UsageRow[] = [];
  const billed = new Set<string>();
  const seen = new Set<string>();
  const journal: JournalEntry[] = [];
  return {
    async recordUsage(u) {
      if (seen.has(u.usageId)) return false;
      seen.add(u.usageId);
      usage.push(u);
      return true;
    },
    async unbilled(mandateId) {
      return usage.filter((u) => u.mandateId === mandateId && !billed.has(u.usageId)).sort((a, b) => a.atMs - b.atMs || a.usageId.localeCompare(b.usageId));
    },
    async markBilled(ids) {
      for (const id of ids) billed.add(id);
    },
    async mandatesWithUnbilled() {
      return [...new Set(usage.filter((u) => !billed.has(u.usageId)).map((u) => u.mandateId))];
    },
    async appendJournal(e) {
      journal.push(e);
    },
    async readJournal() {
      return [...journal];
    },
  };
}

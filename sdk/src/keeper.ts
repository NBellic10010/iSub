import { ChargeMode, MandateStatus } from './constants';
import type { IsubClient } from './client';
import type { IsubSigner } from './signer';
import { IsubAbortError } from './errors';
import {
  memoryStore,
  type KeeperStore,
  type MandateLifecycle,
  type MandateTrack,
  type PersistedKeeperState,
} from './store';

export interface KeeperCharge {
  mandateId: string;
  amount: bigint;
  digest: string;
}
export interface KeeperSkip {
  mandateId: string;
  reason: string;
}
export interface KeeperFail {
  mandateId: string;
  error: string;
  /** true = on-chain abort (retrying won't help); false = transient (RPC/network). */
  deterministic: boolean;
  abortCode: number | null;
}
export interface KeeperTickResult {
  checked: number;
  charged: KeeperCharge[];
  skipped: KeeperSkip[];
  failed: KeeperFail[];
  events: KeeperEvent[];
}

/** Lifecycle + charge notifications — the merchant's webhook seam (P-1/P-5). */
export type KeeperEvent =
  | { type: 'charge.succeeded'; mandateId: string; at: number; amount: bigint; digest: string; seq: number }
  | { type: 'charge.failed'; mandateId: string; at: number; error: string; deterministic: boolean; abortCode: number | null }
  /** Charges found on-chain that this keeper didn't journal (lost response after a crash, or a third party triggered the permissionless Fixed charge). */
  | { type: 'charge.observed'; mandateId: string; at: number; newCount: number }
  | { type: 'mandate.past_due'; mandateId: string; at: number; sinceMs: number }
  | { type: 'mandate.recovered'; mandateId: string; at: number }
  | { type: 'mandate.lapsed'; mandateId: string; at: number }
  | { type: 'mandate.expired'; mandateId: string; at: number }
  | { type: 'mandate.revoked'; mandateId: string; at: number }
  | { type: 'mandate.paused'; mandateId: string; at: number }
  | { type: 'mandate.resumed'; mandateId: string; at: number };

/**
 * Dunning policy: how long a mandate may sit past_due before the keeper gives up.
 * On lapse the keeper PERMANENTLY stops billing that mandate (it may still be valid
 * on-chain — surface a revoke link to the user, and only re-watch on explicit
 * user consent). Service gating on past_due/lapsed is the merchant's call, driven
 * by the emitted events.
 */
export interface DunningPolicy {
  graceMs: number;
}

export interface KeeperOptions {
  store?: KeeperStore;
  dunning?: DunningPolicy;
  onEvent?: (e: KeeperEvent) => void;
  /**
   * Safety margin added to the off-chain due-check (default 750ms). The on-chain
   * Clock can trail wall time slightly; charging inside that window wastes gas on
   * an EIntervalNotElapsed abort. The contract stays the authority either way.
   */
  dueMarginMs?: number;
}

const DEFAULT_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const DEFAULT_DUE_MARGIN_MS = 750;
const E_INTERVAL_NOT_ELAPSED = 6;
const TERMINAL: ReadonlySet<MandateLifecycle> = new Set(['lapsed', 'expired', 'revoked']);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Off-chain keeper for Fixed (subscription) mandates, with a persistent billing
 * state machine.
 *
 * Safety is on-chain (interval/budget/expiry/status re-enforced by the contract;
 * the off-chain guards only avoid wasting gas). What lives HERE is liveness and
 * revenue ops: per-mandate lifecycle (active → past_due → recovered | lapsed),
 * dunning, durable watch set + action journal (restart-safe), failure
 * classification, and drift detection against the on-chain charge counter.
 *
 * Insufficient balance does NOT touch the on-chain mandate (never auto-revoke /
 * auto-pause): the authorization stays valid, so recovery is signature-free —
 * the user tops up, the next tick charges, done.
 *
 * PAYG mandates are skipped by design (amounts are merchant-metered; bill them
 * with `IsubClient.chargeMetered` + its idempotency seq from your billing system).
 */
export class IsubKeeper {
  private readonly isub: IsubClient;
  private readonly signer: IsubSigner;
  private readonly store: KeeperStore;
  private readonly dunning: DunningPolicy;
  private readonly dueMarginMs: number;
  private readonly onEvent?: (e: KeeperEvent) => void;
  private readonly seedIds: string[];
  private tracks = new Map<string, MandateTrack>();
  private initialized = false;

  constructor(
    isub: IsubClient,
    signer: IsubSigner,
    watch: Iterable<string> | KeeperOptions = [],
    opts: KeeperOptions = {},
  ) {
    // Back-compat: third arg is either the initial watch list or the options bag.
    const watchIsOpts = typeof (watch as KeeperOptions).store !== 'undefined' ||
      typeof (watch as KeeperOptions).dunning !== 'undefined' ||
      typeof (watch as KeeperOptions).onEvent !== 'undefined';
    const o = watchIsOpts ? (watch as KeeperOptions) : opts;
    this.isub = isub;
    this.signer = signer;
    this.seedIds = watchIsOpts ? [] : [...(watch as Iterable<string>)];
    this.store = o.store ?? memoryStore();
    this.dunning = o.dunning ?? { graceMs: DEFAULT_GRACE_MS };
    this.dueMarginMs = o.dueMarginMs ?? DEFAULT_DUE_MARGIN_MS;
    this.onEvent = o.onEvent;
  }

  /** Load persisted tracks, merge seed ids, take the single-instance lock. Lazy-called by tick(). */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.acquireLock?.();
    const persisted = await this.store.load();
    for (const [id, t] of Object.entries(persisted?.tracks ?? {})) this.tracks.set(id, t);
    for (const id of this.seedIds) {
      if (!this.tracks.has(id)) this.tracks.set(id, { state: 'active', sinceMs: Date.now() });
    }
    this.initialized = true;
  }

  /** Add mandate ids to the watch set. */
  watch(...ids: string[]): void {
    for (const id of ids) {
      if (!this.tracks.has(id)) this.tracks.set(id, { state: 'active', sinceMs: Date.now() });
    }
  }
  /** Remove mandate ids entirely (lifecycle history is dropped). */
  unwatch(...ids: string[]): void {
    for (const id of ids) this.tracks.delete(id);
  }
  /** Ids the keeper still actively bills (non-terminal). */
  watching(): string[] {
    return [...this.tracks.entries()].filter(([, t]) => !TERMINAL.has(t.state)).map(([id]) => id);
  }
  /** Full lifecycle view, terminal states included (P-5: the merchant's revenue-ops table). */
  snapshot(): Record<string, MandateTrack> {
    return Object.fromEntries([...this.tracks.entries()].map(([id, t]) => [id, { ...t }]));
  }

  /** One sweep over the watched mandates. Never throws on a per-mandate failure. */
  async tick(nowMs: number = Date.now()): Promise<KeeperTickResult> {
    await this.init();
    const now = BigInt(nowMs);
    const result: KeeperTickResult = { checked: 0, charged: [], skipped: [], failed: [] , events: []};
    const emit = (e: KeeperEvent): void => {
      result.events.push(e);
      try {
        this.onEvent?.(e);
      } catch {
        /* listener errors never break the sweep */
      }
    };
    const setState = async (id: string, t: MandateTrack, state: MandateLifecycle): Promise<void> => {
      t.state = state;
      t.sinceMs = nowMs;
      await this.store.appendJournal({ at: nowMs, mandateId: id, kind: 'state', state });
    };

    const ids = this.watching();
    const resolved = await this.isub.getMandatesResolved(ids);
    const acctBal = new Map<string, bigint>(); // K-6: per-tick balance cache, decremented after each charge
    for (const { id: mid, mandate: m } of resolved) {
      result.checked++;
      const t = this.tracks.get(mid)!;
      if (m === null) {
        // K-1: a deleted / unreadable id must NOT abort the sweep. Skip and retry next
        // tick (the merchant backend unwatches mandates it has genuinely removed).
        result.skipped.push({ mandateId: mid, reason: 'unreadable (missing or transient) — retry' });
        continue;
      }

      // Sync with the on-chain charge counter. First sight = baseline; afterwards a
      // jump means charges we didn't journal (lost response / third-party trigger).
      const chainCount = Number(m.chargeSeq);
      if (t.chargeCount === undefined) {
        t.chargeCount = chainCount;
      } else if (chainCount > t.chargeCount) {
        t.chargeCount = chainCount;
        await this.store.appendJournal({ at: nowMs, mandateId: m.id, kind: 'observed', seq: chainCount });
        emit({ type: 'charge.observed', mandateId: m.id, at: nowMs, newCount: chainCount });
        if (t.state === 'past_due') {
          await setState(m.id, t, 'active');
          emit({ type: 'mandate.recovered', mandateId: m.id, at: nowMs });
        }
      }

      // On-chain status transitions.
      if (m.status === MandateStatus.Revoked) {
        await setState(m.id, t, 'revoked');
        emit({ type: 'mandate.revoked', mandateId: m.id, at: nowMs });
        result.skipped.push({ mandateId: m.id, reason: 'revoked (unwatched)' });
        continue;
      }
      if (m.status === MandateStatus.Paused) {
        if (t.state !== 'paused') {
          await setState(m.id, t, 'paused');
          emit({ type: 'mandate.paused', mandateId: m.id, at: nowMs });
        }
        result.skipped.push({ mandateId: m.id, reason: 'paused' });
        continue;
      }
      if (t.state === 'paused') {
        await setState(m.id, t, 'active');
        emit({ type: 'mandate.resumed', mandateId: m.id, at: nowMs });
      }
      if (now >= m.expiryMs) {
        await setState(m.id, t, 'expired');
        emit({ type: 'mandate.expired', mandateId: m.id, at: nowMs });
        result.skipped.push({ mandateId: m.id, reason: 'expired' });
        continue;
      }

      if (m.mode !== ChargeMode.Fixed) {
        result.skipped.push({ mandateId: m.id, reason: 'PAYG (merchant-driven amount)' });
        continue;
      }
      // Earliest chargeable = max(interval watermark, not_before). The contract gates the
      // first charge on `not_before_ms` (trial / first_charge_after delay) via line ~354,
      // but the interval watermark alone reads as "due" from signup onward: authorize sets
      // last_charged_ms = now - interval_ms, so lastChargedMs + intervalMs == signup. Without
      // honoring not_before here, the keeper submits a doomed charge EVERY tick across the
      // whole trial, each aborting EIntervalNotElapsed on-chain — burned gas + journal spam.
      const dueAtMs = m.lastChargedMs + m.intervalMs;
      const earliestMs = dueAtMs > m.notBeforeMs ? dueAtMs : m.notBeforeMs;
      if (now < earliestMs + BigInt(this.dueMarginMs)) {
        result.skipped.push({ mandateId: m.id, reason: 'not due yet' });
        continue;
      }
      if (m.spentTotal + m.price > m.totalBudget) {
        result.skipped.push({ mandateId: m.id, reason: 'budget exhausted' });
        continue;
      }

      let bal = acctBal.get(m.accountId);
      if (bal === undefined) {
        bal = (await this.isub.getAccount(m.accountId)).balance;
        acctBal.set(m.accountId, bal);
      }
      if (bal < m.price) {
        // Dunning (P-1): the mandate is DUE but the Account can't cover it. The
        // on-chain mandate is left untouched — recovery must stay signature-free.
        if (t.state === 'active') {
          await setState(m.id, t, 'past_due');
          emit({ type: 'mandate.past_due', mandateId: m.id, at: nowMs, sinceMs: nowMs });
        } else if (t.state === 'past_due' && nowMs - t.sinceMs >= this.dunning.graceMs) {
          await setState(m.id, t, 'lapsed');
          emit({ type: 'mandate.lapsed', mandateId: m.id, at: nowMs });
          result.skipped.push({ mandateId: m.id, reason: 'lapsed (grace expired, unwatched)' });
          continue;
        }
        result.skipped.push({ mandateId: m.id, reason: 'insufficient balance (grace)' });
        continue;
      }

      const expectedSeq = (t.chargeCount ?? 0) + 1;
      await this.store.appendJournal({
        at: nowMs,
        mandateId: m.id,
        kind: 'submit',
        amount: m.price.toString(),
        seq: expectedSeq,
      });
      try {
        const { digest } = await this.isub.charge(this.signer, {
          accountId: m.accountId,
          mandateId: m.id,
          amount: m.price,
        });
        t.chargeCount = expectedSeq;
        t.lastDigest = digest;
        acctBal.set(m.accountId, bal - m.price); // K-6: reflect the debit for later mandates on this account
        await this.store.appendJournal({
          at: nowMs,
          mandateId: m.id,
          kind: 'charged',
          amount: m.price.toString(),
          digest,
          seq: expectedSeq,
        });
        // K-5: persist chargeCount NOW — a crash before the end-of-tick save must not
        // lose that this charge landed (else restart re-baselines and miscounts).
        await this.store.save(this.persistable());
        result.charged.push({ mandateId: m.id, amount: m.price, digest });
        emit({ type: 'charge.succeeded', mandateId: m.id, at: nowMs, amount: m.price, digest, seq: expectedSeq });
        if (t.state === 'past_due') {
          await setState(m.id, t, 'active');
          emit({ type: 'mandate.recovered', mandateId: m.id, at: nowMs });
        }
      } catch (e) {
        // Classify (P-4): an on-chain abort is deterministic for this tick (the
        // contract said no); anything else is transient (RPC/network) and the next
        // tick simply retries. A 'submit' without a matching 'charged' is resolved
        // later by the drift check. EIntervalNotElapsed is special-cased as a benign
        // race (clock skew / another keeper won) — the chain is the clock authority,
        // so "not due yet per chain" is a normal outcome, not a failure.
        const deterministic = e instanceof IsubAbortError;
        const abortCode = deterministic ? (e as IsubAbortError).abortCode : null;
        if (abortCode === E_INTERVAL_NOT_ELAPSED) {
          await this.store.appendJournal({ at: nowMs, mandateId: m.id, kind: 'skip', reason: 'raced: not due on-chain yet' });
          result.skipped.push({ mandateId: m.id, reason: 'raced: not due on-chain yet' });
          continue;
        }
        const error = e instanceof Error ? e.message : String(e);
        await this.store.appendJournal({ at: nowMs, mandateId: m.id, kind: 'fail', reason: error });
        result.failed.push({ mandateId: m.id, error, deterministic, abortCode });
        emit({ type: 'charge.failed', mandateId: m.id, at: nowMs, error, deterministic, abortCode });
      }
    }

    await this.store.save(this.persistable());
    return result;
  }

  /** Poll until `signal` aborts. Tick-level errors (e.g. RPC down) back off exponentially. */
  async run(opts: {
    pollMs: number;
    signal?: AbortSignal;
    onTick?: (r: KeeperTickResult) => void;
  }): Promise<void> {
    // K-2: acquire the lock up front and FAIL FAST if another live instance holds it —
    // a lock-contention error is terminal, not a transient tick failure to retry forever.
    await this.init();
    let backoffMs = 0;
    while (!opts.signal?.aborted) {
      try {
        opts.onTick?.(await this.tick());
        backoffMs = 0;
      } catch (e) {
        // tick() isolates per-mandate errors; a throw here is discovery-level (RPC blip).
        backoffMs = Math.min(backoffMs > 0 ? backoffMs * 2 : opts.pollMs * 2, 60_000);
        console.error(`keeper: tick failed (retrying in ${backoffMs}ms):`, e instanceof Error ? e.message : e);
      }
      await sleep(backoffMs > 0 ? backoffMs : opts.pollMs);
    }
    await this.close();
  }

  /** Persist and release the single-instance lock. No-op if we never acquired it (so a
   *  lock-contention exit never deletes the holder's lock). */
  async close(): Promise<void> {
    if (!this.initialized) return;
    await this.store.save(this.persistable());
    await this.store.releaseLock?.();
  }

  private persistable(): PersistedKeeperState {
    return { tracks: Object.fromEntries(this.tracks.entries()) };
  }
}

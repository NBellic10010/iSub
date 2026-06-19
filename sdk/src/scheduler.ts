// Architecture A: off-chain phase orchestrator (contract UNCHANGED). Full design in
// product-plan/scheduler-design.md. The keeper (Fixed) / biller (PAYG) still do the
// periodic charging; the scheduler ONLY acts at phase boundaries.
//
// Non-custodial iron law — a signature is a ceiling; the merchant may pull LESS, never
// MORE, without a new signature. So:
//   trial → paid : one signature (first_charge_after_ms) — keeper fires at not_before.
//   downgrade    : SILENT — charge(price) stands, refund(price - effective) per charge.
//   upgrade      : a CONSENT event — emit consent.required, keep billing the old (lower)
//                  price until the subscriber signs a new mandate, then applyConsent().
//   PAYG reprice : SILENT — emit payg.repriced; the biller swaps its RateCard (signed caps).

import { ChargeMode } from './constants';
import type { MandateState } from './types';
import type { IsubSigner } from './signer';
import type { RateCard } from './pricing';

/** One segment of a subscription's lifecycle. Times are absolute ms epoch (resolved at creation). */
export interface SchedulePhase {
  /** Wall-clock ms this phase becomes effective. First phase == signup (or trial end). */
  startMs: number;
  kind: 'fixed' | 'payg';
  /** fixed: per-period price (base units). */
  price?: bigint;
  /** fixed: ms between charges (informational; the keeper bills on mandate.intervalMs). */
  intervalMs?: bigint;
  /** payg: the rate-card to price against (within the mandate's signed caps). */
  rateCard?: RateCard;
  /** 'trial' | 'promo' | 'standard' — for invoices / UI. */
  label?: string;
}

export interface Schedule {
  /** Orchestrator-stable id — survives the mandate-id change on an upgrade. */
  subscriptionId: string;
  accountId: string;
  planId: string;
  merchant: string;
  /** The live on-chain mandate currently billed through. */
  mandateId: string;
  /** Ascending startMs. */
  phases: SchedulePhase[];
  /** Index of the currently-effective phase. */
  cursor: number;
  status: 'active' | 'awaiting_consent' | 'cancelled';
  /** charge_seq already reconciled by silent-refund (idempotency anchor, like keeper.chargeCount). */
  refundedThroughSeq?: number;
  /** While awaiting_consent: the phase index we want to advance INTO once signed. */
  pendingCursor?: number;
}

export interface NewSchedule {
  subscriptionId: string;
  accountId: string;
  planId: string;
  merchant: string;
  mandateId: string;
  phases: SchedulePhase[];
  /** Defaults to Date.now(); pass for determinism. */
  nowMs?: number;
}

export type SchedulerEvent =
  | { type: 'phase.advanced'; subscriptionId: string; at: number; cursor: number; label?: string }
  | { type: 'downgrade.refunded'; subscriptionId: string; at: number; amount: bigint; charges: number; digest: string }
  | { type: 'consent.required'; subscriptionId: string; at: number; fromPrice: bigint; toPrice: bigint; effectiveMs: number }
  | { type: 'payg.repriced'; subscriptionId: string; at: number; rateCard: RateCard }
  | { type: 'mandate.replaced'; subscriptionId: string; at: number; oldMandateId: string; newMandateId: string };

export interface SchedulerTickResult {
  checked: number;
  advanced: string[];
  refunded: { subscriptionId: string; amount: bigint }[];
  consentRequired: string[];
  skipped: { subscriptionId: string; reason: string }[];
  events: SchedulerEvent[];
}

/** Minimal chain surface the scheduler needs — `IsubClient` satisfies it (keeps this testable). */
export interface SchedulerChain {
  getMandatesResolved(ids: string[]): Promise<{ id: string; mandate: MandateState | null }[]>;
  refund(signer: IsubSigner, p: { accountId: string; mandateId: string; amount: bigint }): Promise<{ digest: string }>;
}

/** Where the scheduler persists its schedules. Lock guards two instances driving the same set. */
export interface ScheduleStore {
  load(): Promise<Schedule[]>;
  upsert(s: Schedule): Promise<void>;
  acquireLock?(): Promise<void>;
  releaseLock?(): Promise<void>;
}

/** Volatile store — zero-config default for tests/demos. NOT durable (SQL store is the follow-up). */
export function memoryScheduleStore(): ScheduleStore {
  const byId = new Map<string, Schedule>();
  return {
    load: async () => [...byId.values()].map((s) => ({ ...s, phases: [...s.phases] })),
    upsert: async (s) => {
      byId.set(s.subscriptionId, { ...s, phases: [...s.phases] });
    },
  };
}

const priceOf = (p: SchedulePhase): bigint => p.price ?? 0n;

export interface SchedulerOptions {
  store?: ScheduleStore;
  onEvent?: (e: SchedulerEvent) => void;
}

/**
 * Off-chain phase orchestrator. The constructor signer MUST be the merchant — `refund`
 * (silent downgrade) is merchant-only. Revoking the old mandate on an upgrade is the
 * SUBSCRIBER's action (done in their consent PTB), so the scheduler never revokes.
 */
export class IsubScheduler {
  private readonly chain: SchedulerChain;
  private readonly signer: IsubSigner;
  private readonly store: ScheduleStore;
  private readonly onEvent?: (e: SchedulerEvent) => void;
  private schedules = new Map<string, Schedule>();
  private initialized = false;

  constructor(chain: SchedulerChain, merchantSigner: IsubSigner, opts: SchedulerOptions = {}) {
    this.chain = chain;
    this.signer = merchantSigner;
    this.store = opts.store ?? memoryScheduleStore();
    this.onEvent = opts.onEvent;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.acquireLock?.();
    for (const s of await this.store.load()) this.schedules.set(s.subscriptionId, s);
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (!this.initialized) return;
    await this.store.releaseLock?.();
  }

  snapshot(): Schedule[] {
    return [...this.schedules.values()].map((s) => ({ ...s, phases: [...s.phases] }));
  }

  /** Register a subscription with its phase plan. The mandate must already be authorized on-chain. */
  async schedule(input: NewSchedule): Promise<Schedule> {
    await this.init();
    const now = input.nowMs ?? Date.now();
    const phases = [...input.phases].sort((a, b) => a.startMs - b.startMs);
    // Active phase = the latest one whose startMs has already arrived (else the first).
    let cursor = 0;
    for (let i = 0; i < phases.length; i++) if (phases[i]!.startMs <= now) cursor = i;
    const s: Schedule = {
      subscriptionId: input.subscriptionId,
      accountId: input.accountId,
      planId: input.planId,
      merchant: input.merchant,
      mandateId: input.mandateId,
      phases,
      cursor,
      status: 'active',
    };
    this.schedules.set(s.subscriptionId, s);
    await this.store.upsert(s);
    return { ...s, phases: [...s.phases] };
  }

  /** One sweep: advance arrived phases, run the transition. Never throws on a per-schedule error. */
  async tick(nowMs: number = Date.now()): Promise<SchedulerTickResult> {
    await this.init();
    const result: SchedulerTickResult = { checked: 0, advanced: [], refunded: [], consentRequired: [], skipped: [], events: [] };
    const emit = (e: SchedulerEvent): void => {
      result.events.push(e);
      try { this.onEvent?.(e); } catch { /* listener errors never break the sweep */ }
    };

    const live = [...this.schedules.values()].filter((s) => s.status !== 'cancelled');
    const resolved = await this.chain.getMandatesResolved(live.map((s) => s.mandateId));
    const mById = new Map(resolved.map((r) => [r.id, r.mandate]));

    for (const s of live) {
      result.checked++;
      const m = mById.get(s.mandateId) ?? null;
      if (m === null) {
        // Unreadable (missing/transient) — never abort the sweep; retry next tick.
        result.skipped.push({ subscriptionId: s.subscriptionId, reason: 'mandate unreadable — retry' });
        continue;
      }
      try {
        await this.advanceCursor(s, m, nowMs, emit, result);
        await this.silentRefund(s, m, nowMs, emit, result);
      } catch (e) {
        result.skipped.push({ subscriptionId: s.subscriptionId, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return result;
  }

  /** Advance the cursor to the latest arrived phase — UNLESS it's an upgrade (needs a new signature). */
  private async advanceCursor(
    s: Schedule, m: MandateState, nowMs: number,
    emit: (e: SchedulerEvent) => void, result: SchedulerTickResult,
  ): Promise<void> {
    if (s.status !== 'active') return; // awaiting_consent: frozen on the old phase until applyConsent()
    let target = s.cursor;
    for (let i = s.cursor + 1; i < s.phases.length; i++) {
      if (s.phases[i]!.startMs <= nowMs) target = i; else break;
    }
    if (target === s.cursor) return;

    const ph = s.phases[target]!;
    if (ph.kind === 'fixed' && priceOf(ph) > m.price) {
      // Upgrade: the new price exceeds the signed ceiling → cannot pull more without a new
      // signature. Freeze on the old (lower) phase; the keeper keeps billing it (safe,
      // revenue-delayed) until the subscriber signs and the merchant calls applyConsent().
      s.status = 'awaiting_consent';
      s.pendingCursor = target;
      await this.store.upsert(s);
      result.consentRequired.push(s.subscriptionId);
      emit({ type: 'consent.required', subscriptionId: s.subscriptionId, at: nowMs, fromPrice: m.price, toPrice: priceOf(ph), effectiveMs: ph.startMs });
      return;
    }

    // Downgrade / same-price / PAYG → advance silently.
    s.cursor = target;
    if (ph.kind === 'fixed' && priceOf(ph) < m.price) {
      // Baseline so only charges from HERE on get the delta refunded (past periods were correct).
      s.refundedThroughSeq = Number(m.chargeSeq);
    }
    await this.store.upsert(s);
    result.advanced.push(s.subscriptionId);
    emit({ type: 'phase.advanced', subscriptionId: s.subscriptionId, at: nowMs, cursor: target, label: ph.label });
    if (ph.kind === 'payg' && ph.rateCard) {
      emit({ type: 'payg.repriced', subscriptionId: s.subscriptionId, at: nowMs, rateCard: ph.rateCard });
    }
  }

  /** For an active downgrade phase, refund (price - effective) for each charge since the baseline. */
  private async silentRefund(
    s: Schedule, m: MandateState, nowMs: number,
    emit: (e: SchedulerEvent) => void, result: SchedulerTickResult,
  ): Promise<void> {
    if (s.status !== 'active') return;
    const cur = s.phases[s.cursor]!;
    if (cur.kind !== 'fixed' || priceOf(cur) >= m.price) return; // not a downgrade phase
    const base = s.refundedThroughSeq ?? Number(m.chargeSeq);
    const newCharges = Number(m.chargeSeq) - base;
    if (newCharges <= 0) {
      if (s.refundedThroughSeq === undefined) { s.refundedThroughSeq = Number(m.chargeSeq); await this.store.upsert(s); }
      return;
    }
    const amount = (m.price - priceOf(cur)) * BigInt(newCharges);
    const { digest } = await this.chain.refund(this.signer, { accountId: s.accountId, mandateId: s.mandateId, amount });
    s.refundedThroughSeq = Number(m.chargeSeq);
    await this.store.upsert(s);
    result.refunded.push({ subscriptionId: s.subscriptionId, amount });
    emit({ type: 'downgrade.refunded', subscriptionId: s.subscriptionId, at: nowMs, amount, charges: newCharges, digest });
  }

  /**
   * The subscriber signed the upgrade (a new mandate at the higher price, with the old one
   * revoked in the same PTB). Repoint the subscription, advance past the upgrade phase, and
   * emit `mandate.replaced` so the merchant can rewire the keeper (unwatch old, watch new).
   */
  async applyConsent(subscriptionId: string, newMandateId: string, nowMs: number = Date.now()): Promise<void> {
    await this.init();
    const s = this.schedules.get(subscriptionId);
    if (!s) throw new Error(`unknown subscription ${subscriptionId}`);
    if (s.status !== 'awaiting_consent' || s.pendingCursor === undefined) {
      throw new Error(`subscription ${subscriptionId} is not awaiting consent`);
    }
    const oldMandateId = s.mandateId;
    s.mandateId = newMandateId;
    s.cursor = s.pendingCursor;
    s.pendingCursor = undefined;
    s.status = 'active';
    s.refundedThroughSeq = undefined; // fresh mandate → re-baseline if a later phase downgrades
    this.schedules.set(subscriptionId, s);
    await this.store.upsert(s);
    this.onEvent?.({ type: 'mandate.replaced', subscriptionId, at: nowMs, oldMandateId, newMandateId });
  }

  async cancel(subscriptionId: string): Promise<void> {
    await this.init();
    const s = this.schedules.get(subscriptionId);
    if (!s) return;
    s.status = 'cancelled';
    await this.store.upsert(s);
  }
}

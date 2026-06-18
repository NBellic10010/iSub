// `scheduleLag` — make SILENT subscription revenue-loss VISIBLE.
//
// The contract bills a Fixed mandate at most once per interval and re-bases timing to the
// actual charge moment, so any interval the keeper is late/down is revenue PERMANENTLY
// forgone — and `reconcile` can't see it (it compares charged-vs-journaled, not
// owed-vs-charged). This is the missing signal: a read-only, chain-only probe of how far
// behind schedule each subscription is RIGHT NOW.
//
// Pure + dependency-free (like `exposure`): reads via a narrow `LagChain` (which `IsubClient`
// satisfies), no store, no contract change — so it survives total store loss and can run
// from anywhere. Feed it the caller's FULL historical mandate id set (NOT `keeper.watching()`,
// which drops lapsed mandates that are still valid on-chain revenue).
//
// HONESTY: `lagMs` is a LIVENESS-behind gauge (time past the earliest chargeable moment),
// not a revenue total; and because of the contract's one-charge-per-interval forfeiture,
// `owedRecoverable` is capped at ONE price per behind-and-fundable mandate — running on
// time recovers at most the current period, never the whole backlog.
import { ChargeMode, MandateStatus } from './constants';
import type { MandateState, AccountState } from './types';

/** The slice of `IsubClient` this probe needs (so a mock can stand in for the chain). */
export interface LagChain {
  getMandatesResolved(ids: string[]): Promise<{ id: string; mandate: MandateState | null }[]>;
  getAccount(id: string): Promise<AccountState>;
}

export type LagState =
  | 'on_schedule' // not behind (not yet due, budget-done, or freshly charged)
  | 'arrears_fundable' // Fixed: past due AND the Account can cover the price → OUR liveness miss (recoverable revenue at risk)
  | 'arrears_starved' // Fixed: past due AND the Account can't cover → legitimate past_due (user's account dry, not our failure)
  | 'paused' // subscriber paused on-chain
  | 'expired' // mandate expired
  | 'revoked' // subscriber revoked
  | 'payg_headroom'; // PAYG: usage-driven, no interval lag — report remaining headroom instead

export interface MandateLag {
  mandateId: string;
  accountId: string;
  mode: 'fixed' | 'payg';
  state: LagState;
  /** Fixed: ms past the earliest chargeable moment (0 if on schedule). PAYG: always 0. */
  lagMs: number;
  /** Fixed & fundable-arrears: the price (one period — F-01 caps recovery at one). Else 0. */
  owedRecoverable: bigint;
  /** PAYG only: spendable left in the current rate window. */
  windowHeadroom?: bigint;
  /** PAYG only: remaining total budget. */
  budgetHeadroom?: bigint;
}

export interface ScheduleLagReport {
  at: number;
  checked: number;
  /** Ids that came back unreadable (deleted/transient) — excluded from the rows. */
  unreadable: number;
  /** Fixed mandates that are behind AND fundable — the count that maps to lost-on-liveness revenue. */
  behindFundable: number;
  /** Fixed mandates that are behind because the Account is dry (legitimate past_due, not our miss). */
  behindStarved: number;
  /** Worst single lag (ms) across fundable-arrears mandates. */
  maxLagMs: number;
  /**
   * Sum of `owedRecoverable` across fundable-arrears mandates. This is a LIVENESS UPPER BOUND
   * (≤ one price each), NOT a revenue forecast — the contract forfeits everything beyond the
   * current period, so this is "what catching up right now could still collect", at most.
   */
  owedRecoverableUpperBound: bigint;
  rows: MandateLag[];
}

const DEFAULT_DUE_MARGIN_MS = 750;
const CHUNK = 50; // gRPC getObjects caps objects/call; chunk so a large id set doesn't fail the whole probe
const bmax = (a: bigint, b: bigint): bigint => (a > b ? a : b);

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Probe how far behind schedule each subscription is. Reads each mandate (chunked ≤50/call,
 * fault-isolating: an unreadable id is counted, not fatal) and, for behind Fixed mandates,
 * one Account balance per account (cached) to split a real liveness miss (`arrears_fundable`)
 * from a legitimately dry account (`arrears_starved`).
 *
 * @param ids the caller's FULL set of authorized mandate ids (include lapsed/past_due ones).
 */
export async function scheduleLag(
  chain: LagChain,
  ids: string[],
  opts: { nowMs?: number; dueMarginMs?: number } = {},
): Promise<ScheduleLagReport> {
  const at = opts.nowMs ?? Date.now();
  const now = BigInt(at);
  const margin = BigInt(opts.dueMarginMs ?? DEFAULT_DUE_MARGIN_MS);
  const acctBal = new Map<string, bigint>(); // one balance read per account, cached
  const rows: MandateLag[] = [];
  let unreadable = 0;

  for (const ck of chunk(ids, CHUNK)) {
    const resolved = await chain.getMandatesResolved(ck);
    for (const { id, mandate: m } of resolved) {
      if (m === null) {
        unreadable++;
        continue;
      }
      const mode = m.mode === ChargeMode.Fixed ? 'fixed' : 'payg';
      const base = { mandateId: id, accountId: m.accountId, mode } as const;

      if (m.status === MandateStatus.Revoked) {
        rows.push({ ...base, state: 'revoked', lagMs: 0, owedRecoverable: 0n });
        continue;
      }
      if (m.status === MandateStatus.Paused) {
        rows.push({ ...base, state: 'paused', lagMs: 0, owedRecoverable: 0n });
        continue;
      }
      if (now >= m.expiryMs) {
        rows.push({ ...base, state: 'expired', lagMs: 0, owedRecoverable: 0n });
        continue;
      }
      if (m.mode === ChargeMode.Payg) {
        // Usage-driven — there is no "interval lag". Report headroom so the operator still
        // sees a stalled/over-served PAYG mandate, never an interval-lag false positive.
        const budgetHeadroom = m.totalBudget > m.spentTotal ? m.totalBudget - m.spentTotal : 0n;
        const windowHeadroom =
          now >= m.windowStartMs + m.rateWindowMs ? m.rateCap : m.rateCap > m.windowSpent ? m.rateCap - m.windowSpent : 0n;
        rows.push({ ...base, state: 'payg_headroom', lagMs: 0, owedRecoverable: 0n, windowHeadroom, budgetHeadroom });
        continue;
      }

      // Fixed, active, not expired. Budget exhausted = legitimately complete, not arrears.
      if (m.spentTotal + m.price > m.totalBudget) {
        rows.push({ ...base, state: 'on_schedule', lagMs: 0, owedRecoverable: 0n });
        continue;
      }
      // Earliest chargeable moment = the contract's two gates combined (interval AND not_before),
      // so a first-charge/trial window (notBefore in the future) is NOT flagged behind.
      const dueAt = bmax(m.lastChargedMs + m.intervalMs, m.notBeforeMs);
      if (now < dueAt + margin) {
        rows.push({ ...base, state: 'on_schedule', lagMs: 0, owedRecoverable: 0n });
        continue;
      }

      const lagMs = Number(now - dueAt);
      let bal = acctBal.get(m.accountId);
      if (bal === undefined) {
        bal = (await chain.getAccount(m.accountId)).balance;
        acctBal.set(m.accountId, bal);
      }
      if (bal >= m.price) {
        // Behind AND fundable → we could have charged and didn't: a real liveness miss.
        rows.push({ ...base, state: 'arrears_fundable', lagMs, owedRecoverable: m.price });
      } else {
        // Behind because the Account is dry → legitimate past_due (dunning's job), not our miss.
        rows.push({ ...base, state: 'arrears_starved', lagMs, owedRecoverable: 0n });
      }
    }
  }

  let behindFundable = 0;
  let behindStarved = 0;
  let maxLagMs = 0;
  let owedRecoverableUpperBound = 0n;
  for (const r of rows) {
    if (r.state === 'arrears_fundable') {
      behindFundable++;
      maxLagMs = Math.max(maxLagMs, r.lagMs);
      owedRecoverableUpperBound += r.owedRecoverable;
    } else if (r.state === 'arrears_starved') {
      behindStarved++;
    }
  }
  return { at, checked: rows.length, unreadable, behindFundable, behindStarved, maxLagMs, owedRecoverableUpperBound, rows };
}

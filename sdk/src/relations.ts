// `IsubIndex` — the off-chain RELATIONSHIP INDEX that powers dashboard queries gRPC can't serve.
//
// THE PROBLEM IT SOLVES: gRPC has no event query and cannot enumerate shared objects by owner,
// so the on-chain relationships are unreadable from the chain alone:
//   merchant   → [plans]
//   subscriber → [mandates]  (across ALL merchants), [accounts]
//   plan       → [mandates]  (the plan↔user mapping the dashboard needs)
// The objects exist on-chain; they just can't be listed. This index lists them.
//
// SOURCE = write-time capture (NOT polling): the moment iSub creates a plan/mandate through its
// own surfaces (checkout, merchant-plans, the gateway), it ingests the id here. Every ingest
// RE-DERIVES the row from a chain point-read (getPlan/getMandate/getAccount) — so each row is
// chain-truth, never trusted from the caller. For mandates created OUTSIDE our surfaces (another
// device, a script), `discoverMandatesBySubscriber()` reconciles on demand: it scans the
// subscriber's `MandateAuthorized` events (see ./discovery) and ingests any the index is missing,
// so the subscriber portal can list ALL of a wallet's subscriptions, not just the ones we captured.
//
// INVARIANTS: this is a READ-ONLY projection. It is NOT in the billing hot path and the
// keeper/biller never read it (the "no event query on the hot path" rule stays intact). Its
// tables (idx_*) are kept separate from the keeper's operational `subscriptions` table on purpose,
// so there is no shared source of truth and nothing to drift.
//
// Server-only (node:sqlite). Construct with any chain that can point-read — `IsubClient` fits.
import type { Db } from './db';
import type { PlanState, MandateState, AccountState } from './types';
import { findMandateIdsBySubscriber } from './discovery';

/** The chain point-reads the index needs. `IsubClient` satisfies this structurally. */
export interface RelationChain {
  getPlan(id: string): Promise<PlanState>;
  getMandate(id: string): Promise<MandateState>;
  getAccount(id: string): Promise<AccountState>;
}

export interface PlanRow {
  planId: string;
  merchant: string;
  mode: number;
  price: bigint;
  intervalMs: bigint;
  rateCap: bigint;
  rateWindowMs: bigint;
  keeper: string;
  active: boolean;
  updatedAt: number;
}

export interface MandateRow {
  mandateId: string;
  accountId: string;
  subscriber: string;
  merchant: string;
  planId: string;
  mode: number;
  status: number;
  spentTotal: bigint;
  totalBudget: bigint;
  expiryMs: bigint;
  chargeSeq: bigint;
  updatedAt: number;
}

export interface AccountRow {
  accountId: string;
  owner: string;
  updatedAt: number;
}

export class IsubIndex {
  constructor(
    private readonly chain: RelationChain,
    private readonly db: Db,
    /** Injectable clock (tests pass a fixed one); defaults to wall time. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ===== write-time capture — idempotent upsert by id, re-derived from chain =====

  /** Record (or refresh) a plan. Call after `createPlan*` returns its id. */
  async ingestPlan(planId: string): Promise<PlanRow> {
    const p = await this.chain.getPlan(planId);
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO idx_plans (plan_id, merchant, mode, price, interval_ms, rate_cap, rate_window_ms, keeper, active, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(plan_id) DO UPDATE SET
           merchant=excluded.merchant, mode=excluded.mode, price=excluded.price,
           interval_ms=excluded.interval_ms, rate_cap=excluded.rate_cap, rate_window_ms=excluded.rate_window_ms,
           keeper=excluded.keeper, active=excluded.active, updated_at=excluded.updated_at`,
      )
      .run(p.id, p.merchant, p.mode, s(p.price), s(p.intervalMs), s(p.rateCap), s(p.rateWindowMs), p.keeper, p.active ? 1 : 0, at);
    return { planId: p.id, merchant: p.merchant, mode: p.mode, price: p.price, intervalMs: p.intervalMs, rateCap: p.rateCap, rateWindowMs: p.rateWindowMs, keeper: p.keeper, active: p.active, updatedAt: at };
  }

  /**
   * Record (or refresh) a mandate AND its account (so owner→accounts resolves). Both re-derived
   * from chain. Call after `authorize*` returns the mandate id. A missing/laggy account read
   * does not fail the mandate ingest — the account backfills on a later ingest.
   */
  async ingestMandate(mandateId: string): Promise<MandateRow> {
    const m = await this.chain.getMandate(mandateId);
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO idx_mandates (mandate_id, account_id, subscriber, merchant, plan_id, mode, status, spent_total, total_budget, expiry_ms, charge_seq, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mandate_id) DO UPDATE SET
           account_id=excluded.account_id, subscriber=excluded.subscriber, merchant=excluded.merchant,
           plan_id=excluded.plan_id, mode=excluded.mode, status=excluded.status, spent_total=excluded.spent_total,
           total_budget=excluded.total_budget, expiry_ms=excluded.expiry_ms, charge_seq=excluded.charge_seq,
           updated_at=excluded.updated_at`,
      )
      .run(m.id, m.accountId, m.subscriber, m.merchant, m.planId, m.mode, m.status, s(m.spentTotal), s(m.totalBudget), s(m.expiryMs), s(m.chargeSeq), at);
    try {
      await this.ingestAccount(m.accountId);
    } catch {
      /* account read can lag finality; it backfills on the next ingest */
    }
    return { mandateId: m.id, accountId: m.accountId, subscriber: m.subscriber, merchant: m.merchant, planId: m.planId, mode: m.mode, status: m.status, spentTotal: m.spentTotal, totalBudget: m.totalBudget, expiryMs: m.expiryMs, chargeSeq: m.chargeSeq, updatedAt: at };
  }

  /** Record (or refresh) an account → owner mapping. */
  async ingestAccount(accountId: string): Promise<AccountRow> {
    const a = await this.chain.getAccount(accountId);
    const at = this.now();
    this.db
      .prepare(`INSERT INTO idx_accounts (account_id, owner, updated_at) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET owner=excluded.owner, updated_at=excluded.updated_at`)
      .run(a.id, a.owner, at);
    return { accountId: a.id, owner: a.owner, updatedAt: at };
  }

  // ===== relationship reads — the one-call dashboard API (pure SQL, no chain) =====

  /** A merchant's plans. */
  plansByMerchant(merchant: string): PlanRow[] {
    return (this.db.prepare(`SELECT * FROM idx_plans WHERE merchant = ? ORDER BY updated_at DESC`).all(merchant) as unknown as DbPlan[]).map(planRow);
  }
  /** Every mandate (subscriber) against a merchant's plans. */
  mandatesByMerchant(merchant: string): MandateRow[] {
    return (this.db.prepare(`SELECT * FROM idx_mandates WHERE merchant = ? ORDER BY updated_at DESC`).all(merchant) as unknown as DbMandate[]).map(mandateRow);
  }
  /** A subscriber's mandates ACROSS ALL merchants — the cross-merchant view gRPC cannot build. */
  mandatesBySubscriber(subscriber: string): MandateRow[] {
    return (this.db.prepare(`SELECT * FROM idx_mandates WHERE subscriber = ? ORDER BY updated_at DESC`).all(subscriber) as unknown as DbMandate[]).map(mandateRow);
  }
  /**
   * Like {@link mandatesBySubscriber}, but first RECONCILES the index against chain so the result is
   * the subscriber's COMPLETE set — including mandates authorized outside iSub's surfaces that were
   * never ingested. Scans `MandateAuthorized` events (via ./discovery), then ingests any ids the
   * index is missing (each ingest re-derives the row from a chain point-read; closed/unreadable ones
   * are skipped). Falls back to the plain index read if the event scan fails (RPC down).
   */
  async discoverMandatesBySubscriber(subscriber: string, opts: { rpcUrl: string; packageId: string }): Promise<MandateRow[]> {
    const ids = await findMandateIdsBySubscriber({ rpcUrl: opts.rpcUrl, packageId: opts.packageId, subscriber });
    const known = new Set(this.mandatesBySubscriber(subscriber).map((m) => m.mandateId));
    for (const id of ids) {
      if (known.has(id)) continue;
      try {
        await this.ingestMandate(id);
      } catch {
        /* deleted / closed / not-yet-finalized — leave it out, it can't be read anyway */
      }
    }
    return this.mandatesBySubscriber(subscriber);
  }
  /** The plan↔user mapping: every mandate (subscriber) on a plan. */
  mandatesByPlan(planId: string): MandateRow[] {
    return (this.db.prepare(`SELECT * FROM idx_mandates WHERE plan_id = ? ORDER BY updated_at DESC`).all(planId) as unknown as DbMandate[]).map(mandateRow);
  }
  /** An owner's accounts. */
  accountsByOwner(owner: string): AccountRow[] {
    return (this.db.prepare(`SELECT * FROM idx_accounts WHERE owner = ? ORDER BY updated_at DESC`).all(owner) as unknown as DbAccount[]).map(accountRow);
  }
  /** A single mandate by id (from the index — null if never ingested). */
  mandate(mandateId: string): MandateRow | null {
    const r = this.db.prepare(`SELECT * FROM idx_mandates WHERE mandate_id = ?`).get(mandateId) as unknown as DbMandate | undefined;
    return r ? mandateRow(r) : null;
  }
}

// ===== DB-row → typed-row coercion (TEXT bigints back to bigint; INTEGER flag to boolean) =====

interface DbPlan { plan_id: string; merchant: string; mode: number; price: string; interval_ms: string; rate_cap: string; rate_window_ms: string; keeper: string; active: number; updated_at: number }
interface DbMandate { mandate_id: string; account_id: string; subscriber: string; merchant: string; plan_id: string; mode: number; status: number; spent_total: string; total_budget: string; expiry_ms: string; charge_seq: string; updated_at: number }
interface DbAccount { account_id: string; owner: string; updated_at: number }

const s = (v: bigint): string => v.toString();
const b = (v: string | null): bigint => BigInt(v ?? '0');

function planRow(r: DbPlan): PlanRow {
  return { planId: r.plan_id, merchant: r.merchant, mode: r.mode, price: b(r.price), intervalMs: b(r.interval_ms), rateCap: b(r.rate_cap), rateWindowMs: b(r.rate_window_ms), keeper: r.keeper, active: !!r.active, updatedAt: r.updated_at };
}
function mandateRow(r: DbMandate): MandateRow {
  return { mandateId: r.mandate_id, accountId: r.account_id, subscriber: r.subscriber, merchant: r.merchant, planId: r.plan_id, mode: r.mode, status: r.status, spentTotal: b(r.spent_total), totalBudget: b(r.total_budget), expiryMs: b(r.expiry_ms), chargeSeq: b(r.charge_seq), updatedAt: r.updated_at };
}
function accountRow(r: DbAccount): AccountRow {
  return { accountId: r.account_id, owner: r.owner, updatedAt: r.updated_at };
}

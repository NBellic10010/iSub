// Tenant-scoped `KeeperStore` over the SQL database (db.ts). `sqlStore(db, merchantId)`
// gives the keeper/biller a store whose every read/write is `WHERE merchant_id = ?`, so
// many merchants share one database with hard row-level isolation. Drop-in replacement
// for memoryStore/fileStore — same interface, the keeper code doesn't change.
//
// Server-only — import `@isubpay/sdk/sql-store`.
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Db } from './db';
import type { JournalEntry, KeeperStore, MandateLifecycle, MandateTrack, PersistedKeeperState } from './store';
import type { BillerStore, UsageRow } from './biller';
import type { Schedule, ScheduleStore, SchedulePhase } from './scheduler';
import { IsubError } from './errors';

const LOCK_STALE_MS = 120_000;
const HOST = hostname();

export interface MerchantInit {
  id: string;
  name: string;
  payoutAddress?: string;
  /** Plaintext API key — only its sha256 is stored. */
  apiKey?: string;
}

/** Create or update a tenant. */
export function registerMerchant(db: Db, m: MerchantInit, nowMs: number = Date.now()): void {
  const hash = m.apiKey ? createHash('sha256').update(m.apiKey).digest('hex') : null;
  db.prepare(
    `INSERT INTO merchants (id, name, api_key_hash, payout_address, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, api_key_hash=excluded.api_key_hash, payout_address=excluded.payout_address`,
  ).run(m.id, m.name, hash, m.payoutAddress ?? null, nowMs);
}

/** Look up the merchant id whose API key hashes to `apiKey`, or null (auth). */
export function merchantByApiKey(db: Db, apiKey: string): string | null {
  const hash = createHash('sha256').update(apiKey).digest('hex');
  const row = db.prepare(`SELECT id FROM merchants WHERE api_key_hash = ?`).get(hash) as { id: string } | undefined;
  return row?.id ?? null;
}

export interface SubscriptionInit {
  mandateId: string;
  customerRef?: string;
  accountId?: string;
  planId?: string;
  mode?: number;
}

/** Attach an on-chain mandate to a tenant (the API calls this when `authorize` returns an id). */
export function registerSubscription(db: Db, merchantId: string, s: SubscriptionInit, nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT INTO subscriptions (merchant_id, mandate_id, customer_ref, account_id, plan_id, mode, state, since_ms, charge_count, last_digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?)
     ON CONFLICT(merchant_id, mandate_id) DO UPDATE SET
       customer_ref=excluded.customer_ref, account_id=excluded.account_id, plan_id=excluded.plan_id, mode=excluded.mode`,
  ).run(merchantId, s.mandateId, s.customerRef ?? null, s.accountId ?? null, s.planId ?? null, s.mode ?? null, nowMs, nowMs);
}

interface SubRow {
  mandate_id: string;
  state: string;
  since_ms: number;
  charge_count: number | null;
  last_digest: string | null;
}
interface ChargeRow {
  mandate_id: string;
  kind: string;
  amount: string | null;
  seq: number | null;
  digest: string | null;
  reason: string | null;
  state: string | null;
  usage_ids: string | null;
  at_ms: number;
}
interface LockRow {
  holder: string | null;
  heartbeat_ms: number | null;
}

/** Same-host liveness probe for a `host:pid` lock holder (K-3). Cross-host → assume alive. */
function holderAlive(holder: string | null): boolean {
  if (!holder) return false;
  const sep = holder.lastIndexOf(':');
  const host = holder.slice(0, sep);
  const pid = Number(holder.slice(sep + 1));
  if (host !== HOST || !Number.isInteger(pid) || pid <= 0) return true; // different host → can't tell, assume held
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Row-based single-instance lock over the `locks` table (K-3 liveness). Shared by keeper + biller. */
function makeLock(db: Db, merchantId: string, lockName: string): { acquireLock(): Promise<void>; renewLock(): Promise<void>; releaseLock(): Promise<void> } {
  const holder = `${HOST}:${process.pid}`;
  return {
    async acquireLock(): Promise<void> {
      const row = db
        .prepare(`SELECT holder, heartbeat_ms FROM locks WHERE merchant_id = ? AND name = ?`)
        .get(merchantId, lockName) as unknown as LockRow | undefined;
      if (row && row.heartbeat_ms && Date.now() - row.heartbeat_ms < LOCK_STALE_MS && holderAlive(row.holder)) {
        const age = Math.round((Date.now() - row.heartbeat_ms) / 1000);
        throw new IsubError(
          'lock',
          `another ${lockName} instance holds the lock for merchant ${merchantId} (holder ${row.holder}, heartbeat ${age}s ago). ` +
            `Stop it first — running two wastes gas. (Multi-host: use a Postgres advisory lock instead of this row.)`,
        );
      }
      db.prepare(
        `INSERT INTO locks (merchant_id, name, holder, heartbeat_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(merchant_id, name) DO UPDATE SET holder=excluded.holder, heartbeat_ms=excluded.heartbeat_ms`,
      ).run(merchantId, lockName, holder, Date.now());
    },
    async renewLock(): Promise<void> {
      // Ownership-guarded heartbeat — without this, a healthy long-running holder's heartbeat goes
      // stale after LOCK_STALE_MS and a second instance can take the lock (split-brain double-flush).
      // 0 rows updated = we no longer hold it (superseded) → throw so the run loop stands down.
      const r = db
        .prepare(`UPDATE locks SET heartbeat_ms = ? WHERE merchant_id = ? AND name = ? AND holder = ?`)
        .run(Date.now(), merchantId, lockName, holder);
      if (Number(r.changes) === 0) {
        throw new IsubError('lock', `lost the ${lockName} lock for merchant ${merchantId} (superseded by another instance)`);
      }
    },
    async releaseLock(): Promise<void> {
      // Ownership-guarded — never delete a DIFFERENT holder's row (a superseded instance's close()
      // must not free the new holder's lock).
      db.prepare(`DELETE FROM locks WHERE merchant_id = ? AND name = ? AND holder = ?`).run(merchantId, lockName, holder);
    },
  };
}

/** A `KeeperStore` scoped to one tenant. Use one per (merchant, keeper/biller) pair. */
export function sqlStore(db: Db, merchantId: string, lockName = 'keeper'): KeeperStore {
  return {
    async load(): Promise<PersistedKeeperState | null> {
      const rows = db
        .prepare(`SELECT mandate_id, state, since_ms, charge_count, last_digest FROM subscriptions WHERE merchant_id = ?`)
        .all(merchantId) as unknown as SubRow[];
      if (rows.length === 0) return null;
      const tracks: Record<string, MandateTrack> = {};
      for (const r of rows) {
        tracks[r.mandate_id] = {
          state: r.state as MandateLifecycle,
          sinceMs: r.since_ms,
          chargeCount: r.charge_count ?? undefined,
          lastDigest: r.last_digest ?? undefined,
        };
      }
      return { tracks };
    },

    async save(state: PersistedKeeperState): Promise<void> {
      // Upsert each track's lifecycle columns — never clobbers registration columns
      // (account_id/plan_id/…). Rows for unwatched mandates are intentionally kept
      // (history for the dashboard), unlike the ephemeral memory/file stores.
      const up = db.prepare(
        `INSERT INTO subscriptions (merchant_id, mandate_id, state, since_ms, charge_count, last_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(merchant_id, mandate_id) DO UPDATE SET
           state=excluded.state, since_ms=excluded.since_ms, charge_count=excluded.charge_count, last_digest=excluded.last_digest`,
      );
      db.exec('BEGIN');
      try {
        for (const [mid, t] of Object.entries(state.tracks)) {
          up.run(merchantId, mid, t.state, t.sinceMs, t.chargeCount ?? null, t.lastDigest ?? null, t.sinceMs);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    async appendJournal(e: JournalEntry): Promise<void> {
      db.prepare(
        `INSERT INTO charges (merchant_id, mandate_id, kind, amount, seq, digest, reason, state, usage_ids, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(merchantId, e.mandateId, e.kind, e.amount ?? null, e.seq ?? null, e.digest ?? null, e.reason ?? null, e.state ?? null, e.usageIds ? JSON.stringify(e.usageIds) : null, e.at);
    },

    async readJournal(): Promise<JournalEntry[]> {
      const rows = db
        .prepare(`SELECT mandate_id, kind, amount, seq, digest, reason, state, usage_ids, at_ms FROM charges WHERE merchant_id = ? ORDER BY id`)
        .all(merchantId) as unknown as ChargeRow[];
      return rows.map((r) => ({
        at: r.at_ms,
        mandateId: r.mandate_id,
        kind: r.kind as JournalEntry['kind'],
        amount: r.amount ?? undefined,
        seq: r.seq ?? undefined,
        digest: r.digest ?? undefined,
        reason: r.reason ?? undefined,
        state: (r.state as MandateLifecycle | null) ?? undefined,
        usageIds: r.usage_ids ? (JSON.parse(r.usage_ids) as string[]) : undefined,
      }));
    },

    ...makeLock(db, merchantId, lockName),
  };
}

interface UsageDbRow {
  usage_id: string;
  mandate_id: string;
  amount: string;
  at_ms: number;
}

/** Tenant-scoped `BillerStore` over `usage_records` + `charges`. Drop-in for `memBillerStore`. */
export function sqlBillerStore(db: Db, merchantId: string): BillerStore {
  return {
    async recordUsage(u: UsageRow): Promise<boolean> {
      const r = db
        .prepare(
          `INSERT INTO usage_records (merchant_id, usage_id, mandate_id, amount, at_ms, billed, meter_key, qty, rate_card_version)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
           ON CONFLICT(merchant_id, usage_id) DO NOTHING`,
        )
        .run(
          merchantId,
          u.usageId,
          u.mandateId,
          u.amount.toString(),
          u.atMs,
          u.meterKey ?? null,
          u.qty?.toString() ?? null, // bigint-as-string provenance (audit only; settle reads `amount`)
          u.rateCardVersion ?? null,
        );
      return Number(r.changes) > 0; // false = duplicate usageId (idempotent ingest)
    },

    async unbilled(mandateId: string): Promise<UsageRow[]> {
      const rows = db
        .prepare(`SELECT usage_id, mandate_id, amount, at_ms FROM usage_records WHERE merchant_id = ? AND mandate_id = ? AND billed = 0 ORDER BY at_ms, usage_id`)
        .all(merchantId, mandateId) as unknown as UsageDbRow[];
      return rows.map((r) => ({ usageId: r.usage_id, mandateId: r.mandate_id, amount: BigInt(r.amount), atMs: r.at_ms }));
    },

    async markBilled(usageIds: string[]): Promise<void> {
      if (usageIds.length === 0) return;
      const up = db.prepare(`UPDATE usage_records SET billed = 1 WHERE merchant_id = ? AND usage_id = ?`);
      db.exec('BEGIN');
      try {
        for (const id of usageIds) up.run(merchantId, id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    async mandatesWithUnbilled(): Promise<string[]> {
      const rows = db
        .prepare(`SELECT DISTINCT mandate_id FROM usage_records WHERE merchant_id = ? AND billed = 0`)
        .all(merchantId) as unknown as { mandate_id: string }[];
      return rows.map((r) => r.mandate_id);
    },

    async appendJournal(e: JournalEntry): Promise<void> {
      db.prepare(
        `INSERT INTO charges (merchant_id, mandate_id, kind, amount, seq, digest, reason, state, usage_ids, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(merchantId, e.mandateId, e.kind, e.amount ?? null, e.seq ?? null, e.digest ?? null, e.reason ?? null, e.state ?? null, e.usageIds ? JSON.stringify(e.usageIds) : null, e.at);
    },

    async readJournal(): Promise<JournalEntry[]> {
      const rows = db
        .prepare(`SELECT mandate_id, kind, amount, seq, digest, reason, state, usage_ids, at_ms FROM charges WHERE merchant_id = ? ORDER BY id`)
        .all(merchantId) as unknown as ChargeRow[];
      return rows.map((r) => ({
        at: r.at_ms,
        mandateId: r.mandate_id,
        kind: r.kind as JournalEntry['kind'],
        amount: r.amount ?? undefined,
        seq: r.seq ?? undefined,
        digest: r.digest ?? undefined,
        reason: r.reason ?? undefined,
        state: (r.state as MandateLifecycle | null) ?? undefined,
        usageIds: r.usage_ids ? (JSON.parse(r.usage_ids) as string[]) : undefined,
      }));
    },

    // F5: durable agent-cert rollback floor, tenant-scoped. Survives restart + holds across instances,
    // so `verifyProof` can reject a rotated-out / leaked older cert that the in-memory session never saw.
    async getMaxCertVer(mandateId: string): Promise<number | undefined> {
      const row = db
        .prepare(`SELECT max_ver FROM agent_cert_vers WHERE merchant_id = ? AND mandate_id = ?`)
        .get(merchantId, mandateId) as { max_ver: number } | undefined;
      return row?.max_ver;
    },
    async recordCertVer(mandateId: string, ver: number): Promise<void> {
      db.prepare(
        `INSERT INTO agent_cert_vers (merchant_id, mandate_id, max_ver, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(merchant_id, mandate_id) DO UPDATE SET max_ver = MAX(max_ver, excluded.max_ver), updated_at = excluded.updated_at`,
      ).run(merchantId, mandateId, ver, Date.now());
    },

    ...makeLock(db, merchantId, 'biller'),
  };
}

interface ScheduleDbRow {
  subscription_id: string;
  account_id: string;
  plan_id: string;
  merchant: string;
  mandate_id: string;
  phases: string;
  phase_cursor: number;
  status: string;
  refunded_through_seq: number | null;
  pending_cursor: number | null;
}

// Phases carry bigints (price, intervalMs, and the nested rateCard meter numerics). JSON has
// no bigint, so encode each as {"$b":"…"} and restore on read. Explicit round-trip — the F-07
// lesson: a field the store doesn't handle is silently lost. No SchedulePhase/RateCard field
// is itself an object with a string `$b`, so the reviver can't misfire on real data.
const phasesToJson = (phases: SchedulePhase[]): string =>
  JSON.stringify(phases, (_k, v) => (typeof v === 'bigint' ? { $b: v.toString() } : v));
const phasesFromJson = (text: string): SchedulePhase[] =>
  JSON.parse(text, (_k, v) =>
    v && typeof v === 'object' && typeof (v as { $b?: unknown }).$b === 'string' ? BigInt((v as { $b: string }).$b) : v,
  ) as SchedulePhase[];

/** A `ScheduleStore` (scheduler.ts) scoped to one tenant. Drop-in for `memoryScheduleStore`. */
export function sqlScheduleStore(db: Db, merchantId: string, lockName = 'scheduler'): ScheduleStore {
  return {
    async load(): Promise<Schedule[]> {
      const rows = db
        .prepare(
          `SELECT subscription_id, account_id, plan_id, merchant, mandate_id, phases, phase_cursor, status, refunded_through_seq, pending_cursor
           FROM schedules WHERE merchant_id = ? ORDER BY subscription_id`,
        )
        .all(merchantId) as unknown as ScheduleDbRow[];
      return rows.map((r) => ({
        subscriptionId: r.subscription_id,
        accountId: r.account_id,
        planId: r.plan_id,
        merchant: r.merchant,
        mandateId: r.mandate_id,
        phases: phasesFromJson(r.phases),
        cursor: r.phase_cursor,
        status: r.status as Schedule['status'],
        refundedThroughSeq: r.refunded_through_seq ?? undefined,
        pendingCursor: r.pending_cursor ?? undefined,
      }));
    },

    async upsert(s: Schedule): Promise<void> {
      db.prepare(
        `INSERT INTO schedules (merchant_id, subscription_id, account_id, plan_id, merchant, mandate_id, phases, phase_cursor, status, refunded_through_seq, pending_cursor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(merchant_id, subscription_id) DO UPDATE SET
           account_id=excluded.account_id, plan_id=excluded.plan_id, merchant=excluded.merchant,
           mandate_id=excluded.mandate_id, phases=excluded.phases, phase_cursor=excluded.phase_cursor,
           status=excluded.status, refunded_through_seq=excluded.refunded_through_seq, pending_cursor=excluded.pending_cursor`,
      ).run(
        merchantId, s.subscriptionId, s.accountId, s.planId, s.merchant, s.mandateId,
        phasesToJson(s.phases), s.cursor, s.status, s.refundedThroughSeq ?? null, s.pendingCursor ?? null, Date.now(),
      );
    },

    ...makeLock(db, merchantId, lockName),
  };
}

// ===== per-mandate usage / charge time-series (cross-tenant, by mandate id) =====
// Powers the per-mandate usage chart. Read-only; queried by mandate_id alone (at hackathon scale a
// scan is fine — add a (mandate_id) index if it grows). Mandate data is on-chain-public, so the
// gateway serves these without an api-key (like the /relations/* reads).

export interface UsagePoint {
  usageId: string;
  mandateId: string;
  amount: bigint;
  atMs: number;
  meterKey: string | null;
  qty: bigint | null;
  rateCardVersion: number | null;
  billed: boolean;
}
export interface ChargePoint {
  mandateId: string;
  kind: string;
  amount: bigint | null;
  seq: number | null;
  digest: string | null;
  atMs: number;
}

interface UsageFull { usage_id: string; mandate_id: string; amount: string; at_ms: number; meter_key: string | null; qty: string | null; rate_card_version: number | null; billed: number }
interface ChargeFull { mandate_id: string; kind: string; amount: string | null; seq: number | null; digest: string | null; at_ms: number }

/** Metered usage records for one mandate, oldest-first (the PAYG usage series). */
export function usageByMandate(db: Db, mandateId: string, limit = 2000): UsagePoint[] {
  const rows = db
    .prepare(`SELECT usage_id, mandate_id, amount, at_ms, meter_key, qty, rate_card_version, billed FROM usage_records WHERE mandate_id = ? ORDER BY at_ms LIMIT ?`)
    .all(mandateId, limit) as unknown as UsageFull[];
  return rows.map((r) => ({
    usageId: r.usage_id, mandateId: r.mandate_id, amount: BigInt(r.amount), atMs: r.at_ms,
    meterKey: r.meter_key, qty: r.qty != null ? BigInt(r.qty) : null, rateCardVersion: r.rate_card_version, billed: !!r.billed,
  }));
}

/** Settled charges for one mandate, oldest-first (the settlement series — `kind='charged'`). */
export function chargesByMandate(db: Db, mandateId: string, limit = 2000): ChargePoint[] {
  const rows = db
    .prepare(`SELECT mandate_id, kind, amount, seq, digest, at_ms FROM charges WHERE mandate_id = ? AND kind = 'charged' ORDER BY at_ms LIMIT ?`)
    .all(mandateId, limit) as unknown as ChargeFull[];
  return rows.map((r) => ({ mandateId: r.mandate_id, kind: r.kind, amount: r.amount != null ? BigInt(r.amount) : null, seq: r.seq, digest: r.digest, atMs: r.at_ms }));
}

/**
 * Idempotently record a settled on-chain charge into the gateway journal (`kind='charged'`), so the
 * dashboard's `/charges` series reflects it — including FIXED `charge`s, which don't flow through the
 * metered biller path. Keyed by (mandate_id, seq): re-recording the same charge is a no-op (returns
 * false). Lets the standalone keeper feed the same db the gateway serves, like `biller-run` does.
 */
export function recordCharge(
  db: Db,
  c: { mandateId: string; amount: bigint; seq: number; digest: string; atMs: number; merchantId?: string },
): boolean {
  const dup = db.prepare(`SELECT 1 FROM charges WHERE mandate_id = ? AND seq = ? AND kind = 'charged' LIMIT 1`).get(c.mandateId, c.seq);
  if (dup) return false;
  db.prepare(
    `INSERT INTO charges (merchant_id, mandate_id, kind, amount, seq, digest, reason, state, usage_ids, at_ms)
     VALUES (?, ?, 'charged', ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(c.merchantId ?? 'keeper', c.mandateId, c.amount.toString(), c.seq, c.digest, c.atMs);
  return true;
}

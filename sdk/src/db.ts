// Multi-tenant SQL persistence for the iSub managed backend.
//
// Runs on node:sqlite — zero-install, embedded, and genuinely production-grade for a
// single host. The schema is standard SQL and ports to Postgres for horizontal scale:
// only the driver + a couple of dialect bits (AUTOINCREMENT → IDENTITY/SERIAL, the
// ON CONFLICT upsert is already Postgres-compatible) change. Every row is keyed by
// `merchant_id` — that column IS the tenant boundary.
//
// Requires Node ≥ 22.5 run with --experimental-sqlite. Server-only — import
// `@isub/sdk/db`, never from the browser-safe index.
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  api_key_hash   TEXT,
  payout_address TEXT,
  created_at     INTEGER NOT NULL
);

-- Mandate registry + off-chain lifecycle (the keeper's MandateTrack, per tenant).
CREATE TABLE IF NOT EXISTS subscriptions (
  merchant_id  TEXT NOT NULL,
  mandate_id   TEXT NOT NULL,
  customer_ref TEXT,
  account_id   TEXT,
  plan_id      TEXT,
  mode         INTEGER,
  state        TEXT NOT NULL,
  since_ms     INTEGER NOT NULL,
  charge_count INTEGER,
  last_digest  TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, mandate_id)
);

-- Append-only action journal (the keeper's JournalEntry, per tenant). Reconcile reads it.
CREATE TABLE IF NOT EXISTS charges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  mandate_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  amount      TEXT,
  seq         INTEGER,
  digest      TEXT,
  reason      TEXT,
  state       TEXT,
  usage_ids   TEXT,
  at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charges_tenant_mandate ON charges (merchant_id, mandate_id, id);

-- PAYG usage ingestion + dedupe (the biller). usage_id is the merchant's idempotency key.
CREATE TABLE IF NOT EXISTS usage_records (
  merchant_id TEXT NOT NULL,
  usage_id    TEXT NOT NULL,
  mandate_id  TEXT NOT NULL,
  amount      TEXT NOT NULL,
  at_ms       INTEGER NOT NULL,
  billed      INTEGER NOT NULL DEFAULT 0,
  meter_key         TEXT,
  qty               TEXT,
  rate_card_version INTEGER,
  PRIMARY KEY (merchant_id, usage_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_unbilled ON usage_records (merchant_id, mandate_id, billed);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',
  last_status INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  merchant_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  response    TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, key)
);

CREATE TABLE IF NOT EXISTS locks (
  merchant_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  holder       TEXT,
  heartbeat_ms INTEGER,
  PRIMARY KEY (merchant_id, name)
);
`;

/**
 * Idempotent additive migrations for ALREADY-EXISTING databases. `CREATE TABLE IF NOT EXISTS`
 * only creates fresh tables — it never adds a column to a table that already exists — and
 * node:sqlite has no `ADD COLUMN IF NOT EXISTS`, so every additive column needs a PRAGMA-guarded
 * `ALTER TABLE`. Columns are also added to SCHEMA above so fresh DBs get them directly. Re-running
 * is a no-op. Add new additive columns here (never a destructive change without a real migration).
 */
function addColumnIfMissing(db: Db, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function migrate(db: Db): void {
  // PAYG pricing-layer provenance on the biller-owned usage_records (the frozen `amount` is unchanged).
  addColumnIfMissing(db, 'usage_records', 'meter_key', 'TEXT');
  addColumnIfMissing(db, 'usage_records', 'qty', 'TEXT'); // bigint-as-string, like amount
  addColumnIfMissing(db, 'usage_records', 'rate_card_version', 'INTEGER');
  // Exact batch membership on a biller `submit` (JSON string[]), for safe orphan recovery.
  addColumnIfMissing(db, 'charges', 'usage_ids', 'TEXT');
}

/** Open (or create) the database at `path` (`:memory:` for tests), apply the schema, and migrate. */
export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;'); // crash-safe + concurrent reads
  db.exec(SCHEMA);
  migrate(db); // additive columns for existing DBs (no-op on fresh ones); run before any prepare
  return db;
}

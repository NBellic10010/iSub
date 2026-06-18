// Store-layer smoke — fully headless (no chain). Proves:
//   1. memory / file / SQL stores satisfy the SAME KeeperStore contract,
//   2. the SQL store enforces hard per-tenant (merchant) isolation,
//   3. the single-instance lock blocks a second holder and frees on release,
//   4. API-key auth (sha256) resolves the right tenant.
//
// Run: `npm run store:smoke` (sets --experimental-sqlite for node:sqlite).
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryStore, type KeeperStore } from '../src/store';
import { fileStore } from '../src/store-file';
import { openDb } from '../src/db';
import { sqlStore, registerMerchant, registerSubscription, merchantByApiKey } from '../src/sql-store';

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}

async function contract(name: string, store: KeeperStore): Promise<void> {
  await store.save({ tracks: { '0xa': { state: 'active', sinceMs: 1000, chargeCount: 0 }, '0xb': { state: 'past_due', sinceMs: 2000, lastDigest: '0xd1' } } });
  let s = await store.load();
  check(s?.tracks['0xa']?.state === 'active' && s?.tracks['0xa']?.chargeCount === 0, `${name}: track a round-trips`);
  check(s?.tracks['0xb']?.state === 'past_due' && s?.tracks['0xb']?.lastDigest === '0xd1', `${name}: track b round-trips (digest)`);

  await store.save({ tracks: { '0xa': { state: 'lapsed', sinceMs: 3000, chargeCount: 3 }, '0xb': { state: 'past_due', sinceMs: 2000, lastDigest: '0xd1' } } });
  s = await store.load();
  check(s?.tracks['0xa']?.state === 'lapsed' && s?.tracks['0xa']?.chargeCount === 3, `${name}: track update persists`);

  await store.appendJournal({ at: 1, mandateId: '0xa', kind: 'submit', seq: 1, amount: '50' });
  await store.appendJournal({ at: 2, mandateId: '0xa', kind: 'charged', seq: 1, amount: '50', digest: '0xdig' });
  const j = (await store.readJournal()).filter((e) => e.mandateId === '0xa');
  check(j.length === 2 && j[0]?.kind === 'submit' && j[1]?.digest === '0xdig', `${name}: journal append+read ordered`);
}

async function lockContract(name: string, makeStore: () => KeeperStore): Promise<void> {
  const a = makeStore();
  const b = makeStore(); // a second "instance" over the same backing
  await a.acquireLock?.();
  let blocked = false;
  try {
    await b.acquireLock?.();
  } catch {
    blocked = true;
  }
  check(blocked, `${name}: second acquire blocked while held`);
  await a.releaseLock?.();
  let reacquired = false;
  try {
    await b.acquireLock?.();
    reacquired = true;
  } catch {
    /* still blocked */
  }
  check(reacquired, `${name}: re-acquire after release`);
  await b.releaseLock?.();
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const tmpDir = join(here, '..', 'logs', 'store-smoke-tmp');
  rmSync(tmpDir, { recursive: true, force: true });
  const db = openDb(':memory:');

  console.log('• contract equivalence across all three stores');
  await contract('memory', memoryStore());
  await contract('file', fileStore(join(tmpDir, 'file')));
  await contract('sql', sqlStore(db, 'contract-tenant'));

  console.log('\n• single-instance lock (file + sql)');
  await lockContract('file', () => fileStore(join(tmpDir, 'lock')));
  await lockContract('sql', () => sqlStore(db, 'lock-tenant'));

  console.log('\n• SQL multi-tenant isolation');
  const m1 = sqlStore(db, 'm1');
  const m2 = sqlStore(db, 'm2');
  await m1.save({ tracks: { '0xaaa': { state: 'active', sinceMs: 1 } } });
  await m2.save({ tracks: { '0xbbb': { state: 'revoked', sinceMs: 2 } } });
  await m1.appendJournal({ at: 1, mandateId: '0xaaa', kind: 'charged', seq: 1, amount: '10' });
  await m2.appendJournal({ at: 1, mandateId: '0xbbb', kind: 'charged', seq: 1, amount: '99' });
  const l1 = await m1.load();
  const l2 = await m2.load();
  check(!!l1?.tracks['0xaaa'] && !l1?.tracks['0xbbb'] && Object.keys(l1!.tracks).length === 1, 'm1 loads only its own subscription');
  check(!!l2?.tracks['0xbbb'] && !l2?.tracks['0xaaa'] && Object.keys(l2!.tracks).length === 1, 'm2 loads only its own subscription');
  check((await m1.readJournal()).every((e) => e.amount === '10'), 'm1 journal is tenant-isolated');
  check((await m2.readJournal()).every((e) => e.amount === '99'), 'm2 journal is tenant-isolated');
  await m1.acquireLock?.();
  let m2Independent = false;
  try {
    await m2.acquireLock?.();
    m2Independent = true;
  } catch {
    /* would mean locks leaked across tenants */
  }
  check(m2Independent, 'locks are per-tenant (m2 acquires while m1 holds)');

  console.log('\n• registration + API-key auth');
  registerMerchant(db, { id: 'acme', name: 'Acme Cloud', apiKey: 'sk_test_abc123', payoutAddress: '0xpay' });
  registerSubscription(db, 'acme', { mandateId: '0xm1', customerRef: 'cust_42', accountId: '0xacc', planId: '0xplan', mode: 0 });
  check(merchantByApiKey(db, 'sk_test_abc123') === 'acme', 'API key resolves to the right merchant');
  check(merchantByApiKey(db, 'sk_wrong') === null, 'bad API key resolves to null');
  const reg = await sqlStore(db, 'acme').load();
  check(reg?.tracks['0xm1']?.state === 'active', 'registered subscription appears with active lifecycle');

  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n✅ store smoke passed — ${checks} assertions (memory · file · SQL all green)`);
}

main().catch((e) => {
  console.error('\n❌ store smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

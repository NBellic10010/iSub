// Reconciliation CLI: compare a keeper's journal against on-chain truth.
// Usage: `npm run reconcile [-- <storeDir>]`  /  `ISUB_NETWORK=testnet …`
// Default store dir: .keeper/<network> (the long-running keeper's store).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsubClient, reconcile } from '../src/index';
import { fileStore } from '../src/store-file';
import { clientFor, loadDeployment, fmt, NETWORK } from './env';

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dirArg = process.argv[2];
  const dir = dirArg ? resolve(dirArg) : join(here, '..', '.keeper', NETWORK);

  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const store = fileStore(dir);

  console.log(`• reconciling ${dir} against ${NETWORK} (package ${packageId})\n`);
  const report = await reconcile(isub, store);
  if (report.rows.length === 0) {
    console.log('journal is empty — nothing to reconcile.');
    return;
  }
  for (const r of report.rows) {
    const mark = r.ok ? '✓' : '✗';
    console.log(`${mark} ${r.mandateId}`);
    console.log(
      `    chain: ${r.chainCount} charges, ${fmt(r.chainSpent)} spent, ${fmt(r.chainRefunded)} refunded`,
    );
    console.log(
      `    local: ${r.journaledCount} journaled (${fmt(r.journaledSum)}) + ${r.observedCount} observed → drift ${r.countDrift}` +
        (r.unattributedAmount > 0n ? ` ｜ unattributed ${fmt(r.unattributedAmount)} (externally triggered)` : ''),
    );
  }
  console.log(report.ok ? '\n✅ fully reconciled — zero drift' : '\n❌ DRIFT FOUND — investigate before trusting local books');
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('reconcile failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

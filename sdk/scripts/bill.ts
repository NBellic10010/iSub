// The merchant's billing backend: pull a metered charge against an EXISTING mandate (e.g. a utility
// billing a resident who enabled autopay via the browser wallet). Reports the bill's line items as
// usage against the user's mandate, settles via the keeper → real on-chain charge_metered, and writes
// into the SAME gateway index db the dashboard reads → the bill shows as bars on the UsageChart and
// bumps spent_total. NO agent / NO browser wallet at charge time: the user pre-authorized; the merchant
// pulls within the cap (per-route authMode 'off' — the merchant authenticates itself).
//
// Run: ISUB_NETWORK=testnet NODE_OPTIONS=--experimental-sqlite npm run bill -- 0x<mandateId>
//      (optional: append a single SUI amount to charge one line instead of the default utility bill)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsubClient, keypairSigner } from '../src/index';
import { IsubService } from '../src/service';
import { openDb } from '../src/db';
import { sqlBillerStore } from '../src/sql-store';
import { IsubIndex } from '../src/relations';
import { clientFor, loadOrCreateActor, loadDeployment, fmt, explorer, NETWORK } from './env';

const SUI = 1_000_000_000n;
// Default = the CityGrid utility bill (matches checkout/citygrid.html: 0.12 + 0.06 + 0.02 = 0.20 SUI).
const LINES = [
  { label: 'Electricity', amount: (12n * SUI) / 100n },
  { label: 'Water', amount: (6n * SUI) / 100n },
  { label: 'Waste & recycling', amount: (2n * SUI) / 100n },
];

async function main(): Promise<void> {
  const mandateId = process.argv.find((a) => a.startsWith('0x'));
  if (!mandateId) throw new Error('usage: npm run bill -- 0x<mandateId> [amountSui]');
  const amountArg = process.argv.slice(2).find((a) => !a.startsWith('0x'));
  const lines = amountArg ? [{ label: 'Charge', amount: BigInt(Math.round(Number(amountArg) * 1e9)) }] : LINES;

  const here = dirname(fileURLToPath(import.meta.url));
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const ex = explorer();

  const m = await isub.getMandate(mandateId);
  const keeper = keypairSigner(loadOrCreateActor('keeper', NETWORK), client);
  const db = openDb(process.env.ISUB_INDEX_DB ?? join(here, '..', `isub-index.${NETWORK}.db`));
  // payee MUST equal the mandate's merchant (the service rejects a mismatched payout). Keeper (the
  // plan's authorized_keeper) signs the on-chain charge. authMode 'off' → merchant self-meters (no PoP).
  const service = new IsubService(isub, keeper, m.merchant, sqlBillerStore(db, 'citygrid'), { windowMs: 3_600_000, agentAuth: 'off' });

  try { await new IsubIndex(isub, db).ingestMandate(mandateId); } catch { /* already indexed / lagging */ }

  console.log(`• billing mandate ${mandateId.slice(0, 14)}…  (subscriber ${m.subscriber.slice(0, 10)}…)`);
  let total = 0n;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const r = await service.use(mandateId, l.amount, `bill-${mandateId.slice(2, 10)}-${Date.now()}-${i}`, undefined, 'off');
    if (!r.ok) throw new Error(`${l.label}: charge refused (HTTP ${r.status}: ${r.reason ?? 'not serviceable'})`);
    console.log(`  ✓ ${l.label}: ${fmt(l.amount)} metered`);
    total += l.amount;
  }

  console.log('• settling on-chain (keeper charge_metered)…');
  const fr = await service.flush(mandateId);
  const digests = fr.map((f) => f.digest).filter(Boolean) as string[];
  for (const d of digests) console.log(`  digest: ${d}  ·  ${ex.tx(d)}`);
  const spent = (await isub.getMandate(mandateId)).spentTotal;
  console.log(`\n✅ billed ${fmt(total)} (${lines.length} line item${lines.length > 1 ? 's' : ''}) · on-chain spent_total now ${fmt(spent)}`);
  console.log('   refresh the subscriber dashboard → the bill shows as UsageChart bars + spent.');
  process.exit(0);
}

main().catch((e) => { console.error('\n✗ bill failed:', e instanceof Error ? e.message : e); process.exit(1); });

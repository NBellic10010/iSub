// Run an IsubGateway with the relationship index — the off-chain API the web dashboards query
// (merchant→plans, subscriber→mandates, owner→accounts) + public write-time ingest. Persists to a
// file SQLite so it survives restarts. CORS is on, so the browser app can call it cross-origin.
//
// Run: `npm run gateway:serve` (localnet) or `ISUB_NETWORK=testnet npm run gateway:serve`.
//   PORT=4000 (default) · ISUB_INDEX_DB=isub-index.<network>.db (default)
import { IsubGateway } from '../src/gateway';
import { IsubIndex } from '../src/relations';
import { IsubClient, keypairSigner } from '../src/index';
import { openDb } from '../src/db';
import { clientFor, loadDeployment, loadOrCreateActor, NETWORK } from './env';

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.ISUB_INDEX_DB ?? `isub-index.${NETWORK}.db`;

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const db = openDb(DB_PATH);
  // The keeper key is required by GatewayOptions but unused by the index/relations routes (no charging here).
  const keeper = keypairSigner(loadOrCreateActor('gateway-keeper', NETWORK), client);

  const gateway = new IsubGateway({
    chain: isub,
    keeperSigner: keeper,
    db,
    policy: { windowMs: 3_600_000 },
    routing: () => null, // relations/index + public reads need no tenant routing
    index: new IsubIndex(isub, db),
  });
  gateway.listen(PORT);

  console.log(`• iSub gateway (relationship index) → http://localhost:${PORT}`);
  console.log(`  network ${NETWORK} · package ${packageId.slice(0, 12)}… · db ${DB_PATH}`);
  console.log('  public reads:  GET /relations/plans?merchant= · /relations/mandates?subscriber=|plan=|merchant= · /relations/accounts?owner=');
  console.log('  public ingest: POST /relations/plan {planId} · /relations/mandate {mandateId} · /relations/account {accountId}');
  console.log('  point the web app at it:  NEXT_PUBLIC_GATEWAY_URL=http://localhost:' + PORT);
}

main().catch((e) => {
  console.error('\n✗ gateway-serve failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

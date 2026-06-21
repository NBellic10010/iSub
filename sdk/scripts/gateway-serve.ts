// Run an IsubGateway with the relationship index — the off-chain API the web dashboards query
// (merchant→plans, subscriber→mandates, owner→accounts) + public write-time ingest + the /report
// compliance export. Persists to a file SQLite so it survives restarts.
//
// HOW THE BROWSER REACHES IT (no mixed-content, no CORS): the web app proxies it SAME-ORIGIN — the
// browser calls https://<web>/gw/* and Next forwards here server-side (next.config GATEWAY_ORIGIN,
// default http://localhost:4100). So keep this plain HTTP and run it where the proxy points:
//   `PORT=4100 ISUB_NETWORK=testnet npm run gateway:serve`   (or set GATEWAY_ORIGIN to match)
// Direct HTTPS (only if you run WITHOUT the proxy) is opt-in: set ISUB_TLS_KEY + ISUB_TLS_CERT to PEM
// paths; then point the web at it with NEXT_PUBLIC_GATEWAY_URL=https://localhost:<port>.
import { readFileSync, existsSync } from 'node:fs';
import { IsubGateway } from '../src/gateway';
import { IsubIndex } from '../src/relations';
import { IsubClient, keypairSigner } from '../src/index';
import { openDb } from '../src/db';
import { baseUrlFor, clientFor, loadDeployment, loadOrCreateActor, NETWORK } from './env';

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.ISUB_INDEX_DB ?? `isub-index.${NETWORK}.db`;

// Opt-in HTTPS: ONLY when both PEM paths are given explicitly. Default stays HTTP so the same-origin
// /gw proxy (which fetches us server-side and would reject a self-signed cert) keeps working.
function loadTls(): { key: Buffer; cert: Buffer } | undefined {
  const keyPath = process.env.ISUB_TLS_KEY;
  const certPath = process.env.ISUB_TLS_CERT;
  if (keyPath && certPath && existsSync(keyPath) && existsSync(certPath)) return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  return undefined;
}

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const db = openDb(DB_PATH);
  // The keeper key is required by GatewayOptions but unused by the index/relations routes (no charging here).
  const keeper = keypairSigner(loadOrCreateActor('gateway-keeper', NETWORK), client);

  const tls = loadTls();
  const scheme = tls ? 'https' : 'http';
  const gateway = new IsubGateway({
    chain: isub,
    keeperSigner: keeper,
    db,
    policy: { windowMs: 3_600_000 },
    routing: () => null, // relations/index + public reads need no tenant routing
    index: new IsubIndex(isub, db),
    network: NETWORK, // labels the /report compliance export + its suiscan audit links
    rpcUrl: baseUrlFor(NETWORK), // fullnode JSON-RPC base — enables ?discover=1 mandate reconciliation
    packageId, // namespaces the MandateAuthorized event type scanned during discovery
    tls, // undefined → HTTP (the /gw proxy path); set ISUB_TLS_KEY/CERT for direct HTTPS
  });
  gateway.listen(PORT);

  console.log(`• iSub gateway (relationship index) → ${scheme}://localhost:${PORT}`);
  console.log(`  network ${NETWORK} · package ${packageId.slice(0, 12)}… · db ${DB_PATH}`);
  console.log('  public reads:  GET /relations/plans?merchant= · /relations/mandates?subscriber=[&discover=1]|plan=|merchant= · /relations/accounts?owner=');
  console.log('  compliance:    GET /report?subscriber=<addr> | ?merchant=<addr>  [&month=YYYY-MM] [&format=json]  → monthly CSV');
  console.log('  public ingest: POST /relations/plan {planId} · /relations/mandate {mandateId} · /relations/account {accountId}');
  console.log(`  the web reaches it via the /gw same-origin proxy (next.config GATEWAY_ORIGIN, default http://localhost:4100) — run with PORT=4100 or set GATEWAY_ORIGIN to match`);
}

main().catch((e) => {
  console.error('\n✗ gateway-serve failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

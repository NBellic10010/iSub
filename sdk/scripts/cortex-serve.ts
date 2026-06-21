// REAL pay-as-you-go SERVICE — the merchant's paid Cortex MCP API. ANY caller presenting a VALID PAYG
// mandate for this merchant (active, correct plan/merchant, within budget + rate cap) can use it; each
// REAL request meters exactly that one call and settles charge_metered on-chain (keeper-signed,
// authMode 'off' — works with a browser-checkout mandate, no agent cert), then returns the result.
//
// The on-chain MANDATE is the authorization: there is NO mandate whitelist and NO timer. An invalid /
// revoked / paused / over-budget mandate is refused per call (402/403). It writes usage+charges into
// the gateway db so /app shows it live. Run ONE of these per merchant:
//   ISUB_NETWORK=testnet PORT=4500 npm run cortex-serve
//   curl -X POST localhost:4500/web_search -H 'content-type: application/json' -d '{"mandateId":"0x..","query":"sui"}'
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsubClient, keypairSigner } from '../src/index';
import { IsubService } from '../src/service';
import { openDb } from '../src/db';
import { sqlBillerStore } from '../src/sql-store';
import { clientFor, loadOrCreateActor, loadDeployment, fmt, explorer, NETWORK } from './env';

const SUI = 1_000_000_000n;
const SERVICES: Record<string, bigint> = { web_search: SUI / 1000n, code_interpreter: (3n * SUI) / 1000n, vision: (5n * SUI) / 1000n };
const PORT = Number(process.env.PORT ?? 4500);
const PLAN = process.env.ISUB_PLAN ?? '0x6ff9664b6435bdeef6e24e7fdbb5caa296fab1194550b767eac8e428870825c3'; // cortex PAYG

/** The actual work behind a call. web_search hits a real public API (a genuine network call sits behind
 *  the charge); the others return an illustrative result. The PAYMENT is real on-chain regardless. */
async function runService(service: string, query: string): Promise<string> {
  if (service === 'web_search') {
    try {
      const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query || 'Sui blockchain')}&format=json&no_html=1`);
      const j = (await r.json()) as { AbstractText?: string; Heading?: string; RelatedTopics?: { Text?: string }[] };
      return j.AbstractText || j.Heading || j.RelatedTopics?.find((t) => t.Text)?.Text || `(no abstract for "${query}")`;
    } catch (e) {
      return `(search unreachable: ${e instanceof Error ? e.message : e})`;
    }
  }
  if (service === 'code_interpreter') {
    if (/^[\d\s+\-*/().]+$/.test(query.trim()) && query.trim()) {
      try { return `= ${Function(`"use strict";return (${query})`)()}`; } catch { /* fall through */ }
    }
    return `ran code for: ${query || '(no input)'}`;
  }
  return `analyzed input: ${query || '(no input)'}`;
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const merchant = process.env.ISUB_MERCHANT ?? (await isub.quoteFromPlan(PLAN)).merchant;
  const keeper = keypairSigner(loadOrCreateActor('keeper', NETWORK), client); // the plan's authorized_keeper settles
  const here = dirname(fileURLToPath(import.meta.url));
  const db = openDb(process.env.ISUB_INDEX_DB ?? join(here, '..', `isub-index.${NETWORK}.db`));
  // agentAuth 'off' → keeper self-meters (no PoP/cert). The service validates each call against chain:
  // mandate must be PAYG, for THIS merchant, active, and within budget — that's the whole authorization.
  const svc = new IsubService(isub, keeper, merchant, sqlBillerStore(db, 'cortex-serve'), { windowMs: 3_600_000, agentAuth: 'off' });
  const ex = explorer();
  let seq = 0;

  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return void send(res, 204, {});
    const service = (req.url ?? '').replace(/^\//, '').split('?')[0] ?? '';
    if (req.method !== 'POST' || !(service in SERVICES)) {
      return void send(res, 404, { error: `POST /<service> with {mandateId, query}; services: ${Object.keys(SERVICES).join(', ')}` });
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      void (async () => {
        try {
          const { mandateId, query } = JSON.parse(body || '{}') as { mandateId?: string; query?: string };
          if (!mandateId) return void send(res, 400, { error: 'body needs { mandateId, query }' });
          const price = SERVICES[service]!;
          // Meter THIS call against the caller's mandate — any valid one is accepted, invalid refused.
          const used = await svc.use(mandateId, price, `cortex-serve-${mandateId.slice(2, 10)}-${Date.now()}-${seq++}`, undefined, 'off');
          if (!used.ok) {
            console.log(`✗ ${service} ${mandateId.slice(0, 10)}… refused (${used.status}): ${used.reason}`);
            return void send(res, used.status, { error: used.reason });
          }
          const result = await runService(service, query ?? '');
          const fr = await svc.flush(mandateId);
          const charged = fr.reduce((s, f) => s + (f.charged ?? 0n), 0n);
          const digest = fr.map((f) => f.digest).filter(Boolean)[0] ?? null;
          const m = await isub.getMandate(mandateId);
          console.log(`✓ ${service} ${mandateId.slice(0, 10)}… charged ${fmt(charged)} → spent ${fmt(m.spentTotal)}/${fmt(m.totalBudget)}${digest ? `  ${digest.slice(0, 10)}…` : ' (carried)'}`);
          send(res, 200, {
            service, result,
            charged: charged.toString(), spent: m.spentTotal.toString(), budget: m.totalBudget.toString(),
            settled: digest != null, digest, explorer: digest ? ex.tx(digest) : null,
          });
        } catch (e) {
          send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      })();
    });
  });

  server.listen(PORT, () => {
    console.log(`• Cortex PAYG service → http://localhost:${PORT}  (merchant ${merchant.slice(0, 12)}…, keeper ${keeper.address.slice(0, 10)}…)`);
    console.log('  charges ANY valid PAYG mandate for this merchant, per real call — no whitelist, no timer');
    console.log(`  services: ${Object.entries(SERVICES).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}`);
    console.log(`  curl -X POST localhost:${PORT}/web_search -H 'content-type: application/json' -d '{"mandateId":"0x..","query":"sui"}'`);
  });
}

main().catch((e) => {
  console.error('\n✗ cortex-serve failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

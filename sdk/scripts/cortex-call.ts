// Client for the Cortex PAYG service (cortex-serve): make ONE real call → the service charges ONE
// on-chain payment against your mandate. cortex-serve ENFORCES an agent proof-of-possession by default
// (a bare public mandateId is a bearer token, not a credential), so this client PRESENTS one: it loads
// the delegated agent key + the subscriber-signed cert from the agent config, picks a usageId, and
// SIGNS that exact call (signCall) — sending agentSig/agentSigNotAfter/agentCert in the body.
//
// The agent config is produced by the testnet setup (run `npm run x402-testnet:setup` — it writes
// scripts/.x402-testnet.json with the mandate, the agent secret key, and the cert). Reuse it here.
//   ISUB_NETWORK=testnet npm run cortex-call -- web_search "latest sui news"
//   flags: --url http://host:port · --config scripts/.x402-testnet.json · --insecure 0x<mandateId> (keyless demo)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { signCall, payloadOf } from '../src/agent-auth';

const SERVICES = ['web_search', 'code_interpreter', 'vision'];

interface AgentConfig {
  mandateId: string;
  payoutAddress: string;
  agentSecretKey: string;
  cert: { agent: string; notAfter: string; ver: number; sig: string };
  apis?: { path: string; price: string }[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const url = (flag('--url') ?? 'http://localhost:4500').replace(/\/$/, '');
  const service = args.find((a) => SERVICES.includes(a));
  const insecureMandate = flag('--insecure'); // keyless demo: pass the mandateId directly, send NO PoP
  const query = args.filter((a, i) => a !== service && !a.startsWith('--') && args[i - 1] !== '--url' && args[i - 1] !== '--config' && args[i - 1] !== '--insecure').join(' ');
  if (!service) throw new Error(`usage: npm run cortex-call -- <${SERVICES.join('|')}> [query]  [--url ..] [--config ..] [--insecure 0x<mandateId>]`);

  // === KEYLESS path (CORTEX_INSECURE_BEARER server only): send just { mandateId, query } ===
  if (insecureMandate) {
    console.log(`→ ${service} (KEYLESS / no PoP) on ${insecureMandate.slice(0, 12)}…`);
    const r = await fetch(`${url}/${service}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandateId: insecureMandate, query }) });
    const j = (await r.json()) as Record<string, any>;
    if (!r.ok) throw new Error(`refused (HTTP ${r.status}): ${j.error} — a secure cortex-serve needs a PoP; drop --insecure and use the agent config.`);
    return void report(j);
  }

  // === SECURE path: present a per-call agent PoP from the agent config ===
  const here = dirname(fileURLToPath(import.meta.url));
  const cfgPath = flag('--config') ?? join(here, '.x402-testnet.json');
  let cfg: AgentConfig;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as AgentConfig;
  } catch {
    throw new Error(`no agent config at ${cfgPath}. Run \`npm run x402-testnet:setup\` first (it writes the mandate + agent key + cert), or use --insecure 0x<mandateId> against a CORTEX_INSECURE_BEARER server.`);
  }
  const agentKp = Ed25519Keypair.fromSecretKey(cfg.agentSecretKey);
  const price = cfg.apis?.find((a) => a.path === `/${service}`)?.price;
  if (!price) throw new Error(`config has no price for /${service} (apis: ${cfg.apis?.map((a) => a.path).join(', ') ?? 'none'})`);

  const usageId = `cortex-${service}-${randomUUID()}`;
  const notAfter = BigInt(Date.now()) + 60_000n;
  // Sign THIS exact call: bind mandate · usageId · merchant · amount · not_after — the same fields the
  // service re-derives and verifies. The cert (subscriber-signed) proves this agent key may spend.
  const { sig } = await signCall(agentKp, { mandateId: cfg.mandateId, usageId, merchant: cfg.payoutAddress, payload: payloadOf(undefined, BigInt(price)), notAfter });

  console.log(`→ ${service}${query ? ` ("${query}")` : ''}  on ${cfg.mandateId.slice(0, 12)}…  (agent PoP, usage ${usageId.slice(0, 18)}…)`);
  let r: Response;
  try {
    r = await fetch(`${url}/${service}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mandateId: cfg.mandateId, query, usageId, agentSig: sig, agentSigNotAfter: Number(notAfter), agentCert: cfg.cert }),
    });
  } catch (e) {
    throw new Error(`can't reach the service at ${url} — is cortex-serve running? (${e instanceof Error ? e.message : e})`);
  }
  const j = (await r.json()) as Record<string, any>;
  if (!r.ok) throw new Error(`payment refused (HTTP ${r.status}): ${j.error}`);
  report(j);
}

function report(j: Record<string, any>): void {
  const sui = (x?: string): string => (x ? (Number(x) / 1e9).toFixed(4) : '?');
  console.log(`\n✅ result: ${j.result}`);
  console.log(`💳 charged ${sui(j.charged)} SUI for this call → spent ${sui(j.spent)} / ${sui(j.budget)} SUI${j.settled ? '' : ' (recorded; not settled — account funded?)'}`);
  if (j.explorer) console.log(`   on-chain: ${j.explorer}`);
  console.log('   (run again to make another call — one charge per call)');
}

main().catch((e) => {
  console.error('\n✗ cortex-call:', e instanceof Error ? e.message : e);
  process.exit(1);
});

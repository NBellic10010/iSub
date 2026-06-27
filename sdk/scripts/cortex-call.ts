// Client for the Cortex PAYG service (cortex-serve): make ONE real call → the service charges ONE
// on-chain payment against YOUR mandate. Run it once per use — the charge follows the call, nothing
// automatic. A revoked / over-budget mandate is refused by the service.
//
// NOTE: cortex-serve ENFORCES an agent proof-of-possession by default (a bare public mandateId is a
// bearer token, not a credential). This keyless client sends only { mandateId, query }, so it works
// against cortex-serve ONLY when that server runs with CORTEX_INSECURE_BEARER=1 (the keyless demo,
// behind a trusted session-auth front). The secure path is an AGENT that signs each call — see the
// x402-agent / isub-claude flows.
//   ISUB_NETWORK=testnet npm run cortex-call -- 0x<mandateId> web_search "latest sui news"
//   (point at a non-default service with --url http://host:port)
const SERVICES = ['web_search', 'code_interpreter', 'vision'];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const url = (flag('--url') ?? 'http://localhost:4500').replace(/\/$/, '');
  const mandateId = args.find((a) => a.startsWith('0x'));
  const service = args.find((a) => SERVICES.includes(a));
  const query = args.filter((a) => a !== mandateId && a !== service && a !== '--url' && a !== url).join(' ');
  if (!mandateId || !service) {
    throw new Error(`usage: npm run cortex-call -- 0x<mandateId> <${SERVICES.join('|')}> [query]   (service: cortex-serve at ${url})`);
  }

  console.log(`→ ${service}${query ? ` ("${query}")` : ''}  on ${mandateId.slice(0, 12)}…`);
  let r: Response;
  try {
    r = await fetch(`${url}/${service}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandateId, query }) });
  } catch (e) {
    throw new Error(`can't reach the service at ${url} — is cortex-serve running? (${e instanceof Error ? e.message : e})`);
  }
  const j = (await r.json()) as { result?: string; charged?: string; spent?: string; budget?: string; settled?: boolean; explorer?: string; error?: string };
  if (r.status === 403 && /proof|bearer/i.test(j.error ?? '')) {
    throw new Error(
      `cortex-serve requires an agent proof-of-possession (HTTP 403: ${j.error}). This keyless client sends no PoP — ` +
        `run the server in keyless-demo mode (CORTEX_INSECURE_BEARER=1 npm run cortex-serve), or call it from an agent that signs each call (x402-agent / isub-claude).`,
    );
  }
  if (!r.ok) throw new Error(`payment refused (HTTP ${r.status}): ${j.error}`);
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

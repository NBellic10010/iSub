// Client for the Cortex PAYG service (cortex-serve): make ONE real call → the service charges ONE
// on-chain payment against YOUR mandate. Run it once per use — the charge follows the call, nothing
// automatic. Any valid PAYG mandate works; a revoked / over-budget one is refused by the service.
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

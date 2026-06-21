// Automated PAYG charging runner for ONE mandate.
//
// The automated charging loop: each tick it records metered usage and flushes it to an on-chain
// `charge_metered` (signed by the mandate's merchant/keeper). Reuses the tested IsubBiller (clamp to
// rate_cap/budget/max_per_charge, carry, seq-idempotency, lost-ack recovery) + a persistent SQL store
// (idempotent across restarts). In production your SERVICE calls recordUsage per API hit and this loop
// (or `--flush-only`) settles it; here a tick generates demo usage so the whole path is visible.
//
// The signer MUST be the mandate's merchant or authorized_keeper. Provide it (NOT auto-created):
//   mkdir -p .secrets/<network>
//   sui keytool export --key-identity <ADDRESS> --json | jq -r .exportedPrivateKey > .secrets/<network>/keeper.key
//
// Run:
//   ISUB_NETWORK=testnet npm run biller:run -- 0x<mandateId>            # tick loop until budget/Ctrl-C
//   ISUB_NETWORK=testnet npm run biller:run -- 0x<mandateId> --once     # one charge then exit
//   ISUB_NETWORK=testnet npm run biller:run -- 0x<mandateId> --per 0.03 --every 20
//   ISUB_NETWORK=testnet npm run biller:run -- 0x<mandateId> --flush-only   # settle externally-fed usage only
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubClient, keypairSigner, ChargeMode, MandateStatus, errorName, abortCodeOf, type IsubSigner } from '../src/index';
import { IsubBiller } from '../src/biller';
import { IsubIndex } from '../src/relations';
import { openDb } from '../src/db';
import { sqlBillerStore } from '../src/sql-store';
import { clientFor, loadDeployment, fmt, sleep, explorer, NETWORK } from './env';

const here = dirname(fileURLToPath(import.meta.url));

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string): boolean => process.argv.includes(flag);
const SUI = 1_000_000_000n;
const toMist = (sui: string): bigint => {
  const [w, f = ''] = sui.trim().split('.');
  return BigInt(w || '0') * SUI + BigInt((f + '000000000').slice(0, 9) || '0');
};

/**
 * Load the charging signer (the mandate's merchant/keeper) — load-only, never create.
 * Key file: `--key <path>` or ISUB_KEEPER_KEY (resolved against cwd), else .secrets/<network>/keeper.key.
 * Use --key to point at YOUR own key without clobbering the shared test `keeper.key`.
 */
function loadKeeperSigner(client: ReturnType<typeof clientFor>): IsubSigner {
  const override = arg('--key') ?? process.env.ISUB_KEEPER_KEY;
  const file = override ? resolve(process.cwd(), override) : join(here, '..', '.secrets', NETWORK, 'keeper.key');
  if (!existsSync(file)) {
    throw new Error(
      `no charging key at ${file}\n` +
        `Provide the mandate's merchant/keeper key (NOT auto-created). e.g.:\n` +
        `  mkdir -p .secrets/${NETWORK}\n` +
        `  sui keytool export --key-identity <ADDRESS> --json | jq -r .exportedPrivateKey > .secrets/${NETWORK}/wallet.key\n` +
        `  npm run biller:run -- 0x<mandateId> --once --key .secrets/${NETWORK}/wallet.key`,
    );
  }
  return keypairSigner(Ed25519Keypair.fromSecretKey(readFileSync(file, 'utf8').trim()), client);
}

async function main(): Promise<void> {
  const mandateId = process.argv.slice(2).find((a) => a.startsWith('0x'));
  if (!mandateId) throw new Error('usage: npm run biller:run -- 0x<mandateId> [--per <SUI>] [--every <sec>] [--once] [--flush-only]');

  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const ex = explorer();
  const signer = loadKeeperSigner(client);

  // Preflight: the mandate must be a live PAYG mandate this signer is allowed to charge.
  const m = await isub.getMandate(mandateId);
  if (m.mode !== ChargeMode.Payg) throw new Error(`mandate ${mandateId} is not PAYG (mode=${m.mode}) — use the Fixed keeper for subscription plans`);
  if (m.status !== MandateStatus.Active) throw new Error(`mandate is not Active (status=${m.status}) — paused/revoked mandates can't be charged`);
  if (signer.address !== m.merchant && signer.address !== m.authorizedKeeper) {
    throw new Error(`signer ${signer.address} is neither the mandate's merchant (${m.merchant}) nor keeper (${m.authorizedKeeper}) — wrong key`);
  }

  console.log(`• network ${NETWORK} ｜ package ${packageId}`);
  console.log(`• mandate ${mandateId}`);
  console.log(`  account ${m.accountId} · spent ${fmt(m.spentTotal)} / ${fmt(m.totalBudget)} · rate ${fmt(m.rateCap)}/${Number(m.rateWindowMs) / 1000}s · maxPer ${fmt(m.maxPerCharge)}`);
  console.log(`• signer ${signer.address} (${signer.address === m.merchant ? 'merchant' : 'keeper'})`);

  // Write usage/charges to the SAME db the gateway serves (isub-index.<network>.db), so the dashboard's
  // usage chart / wallet table can actually read them. Override with ISUB_INDEX_DB. Persistent + idempotent.
  const db = openDb(process.env.ISUB_INDEX_DB ?? join(here, '..', `isub-index.${NETWORK}.db`));
  const store = sqlBillerStore(db, 'biller-run');

  // Make the mandate discoverable in the dashboard (idx_mandates → mandatesBySubscriber) so its usage/
  // charges show up even if the subscribe-time ingest was skipped (gateway down). Best-effort — charging
  // does not depend on it.
  try {
    await new IsubIndex(isub, db).ingestMandate(mandateId);
    console.log('• indexed mandate — discoverable in the dashboard');
  } catch (e) {
    console.log(`• index upsert skipped (${e instanceof Error ? e.message : e}) — charging unaffected`);
  }
  const biller = new IsubBiller(isub, signer, store, {
    onEvent: (e) => {
      if (e.type === 'charge.succeeded') console.log(`  ✓ charged ${fmt(e.amount)} (${e.digest.slice(0, 12)}…)`);
      else if (e.type === 'charge.failed') console.log(`  ✗ ${e.deterministic ? `abort ${errorName(e.abortCode ?? -1)} (#${e.abortCode})` : 'transient'}: ${e.error}`);
      else if (e.type === 'budget.exhausted') console.log('  ⚑ budget exhausted');
      else if (e.type === 'usage.carried') console.log(`  ↪ carried ${fmt(e.amount)} (${e.reason})`);
    },
  });
  await biller.init();

  const ac = new AbortController();
  process.on('SIGINT', () => { console.log('\nstopping…'); ac.abort(); });

  // --flush-only: settle usage fed by your service (recordUsage elsewhere) — the production shape.
  if (has('--flush-only')) {
    console.log('• flush-only: settling externally-recorded usage every 5s (Ctrl-C to stop)\n');
    await biller.run({ pollMs: 5000, signal: ac.signal, onTick: (rs) => {
      const c = rs.reduce((s, r) => s + r.charged, 0n);
      if (c > 0n) console.log(`  flushed ${fmt(c)}`);
    } });
    await biller.close();
    return;
  }

  const per = toMist(arg('--per') ?? '0.02');
  const everyMs = Math.max(1, Number(arg('--every') ?? '15')) * 1000;
  const once = has('--once');
  console.log(once ? '\n• one charge then exit' : `\n• tick: record ${fmt(per)} usage + flush every ${everyMs / 1000}s, until budget or Ctrl-C\n`);

  let n = 0;
  while (!ac.signal.aborted) {
    n++;
    const usageId = `run-${mandateId.slice(2, 10)}-${n}-${Date.now()}`;
    await biller.recordUsage({ mandateId, amount: per, usageId });
    const [r] = await biller.flush(mandateId);
    const mm = await isub.getMandate(mandateId);
    console.log(`tick ${n}: charged ${fmt(r?.charged ?? 0n)} · carried ${fmt(r?.carried ?? 0n)} → spent ${fmt(mm.spentTotal)} / ${fmt(mm.totalBudget)} · seq ${mm.chargeSeq}`);
    if (mm.spentTotal >= mm.totalBudget) { console.log('• budget fully spent — done'); break; }
    if (mm.status !== MandateStatus.Active) { console.log('• mandate no longer active — done'); break; }
    if (once) break;
    await sleep(everyMs);
  }

  await biller.close();
  console.log(`• explorer mandate ${ex.object(mandateId)}`);
}

main().catch((e) => {
  console.error('\n❌ biller-run failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

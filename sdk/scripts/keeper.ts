// Long-running keeper: bills Fixed mandates with the full state machine (past_due → recovered |
// lapsed), durable store + journal under .keeper/<network>, and mirrors each charge into the gateway
// index db the dashboards read. It AUTO-DISCOVERS what to bill — point it at a plan or a merchant and
// it watches EVERY active Fixed mandate there, refreshing every 15s so newly-subscribed mandates start
// billing on their own (no hand-feeding ids):
//   npm run keeper -- --plan 0x<planId>        # bill all subscribers on one plan
//   npm run keeper -- --merchant 0x<address>   # bill all of a merchant's Fixed mandates
//   npm run keeper -- 0x<mandateId> …          # or pin specific mandates (merges with the above)
// (ISUB_NETWORK=testnet for testnet.) Discovery reads the same isub-index.<network>.db the gateway serves.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsubClient, IsubKeeper, keypairSigner, ChargeMode, MandateStatus } from '../src/index';
import { fileStore } from '../src/store-file';
import { openDb } from '../src/db';
import { recordCharge } from '../src/sql-store';
import { IsubIndex } from '../src/relations';
import { clientFor, actor, loadDeployment, fmt, NETWORK } from './env';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const planId = flag('--plan');
  const merchant = flag('--merchant');
  // Pinned mandate ids = positional 0x args ONLY — exclude the --plan/--merchant VALUES, else the plan
  // id (it also starts with 0x) gets watched as a bogus "mandate" and every charge tick fails.
  const flagVals = new Set([planId, merchant].filter((x): x is string => !!x));
  const ids = args.filter((a) => a.startsWith('0x') && !flagVals.has(a));
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });

  const keeperKp = await actor(client, 'keeper');
  const signer = keypairSigner(keeperKp, client);
  const here = dirname(fileURLToPath(import.meta.url));
  const store = fileStore(join(here, '..', '.keeper', NETWORK));

  // Mirror each settled charge into the gateway index db the dashboard reads (isub-index.<network>.db),
  // so FIXED charges show on the subscriber dashboard's UsageChart / wallet table — same as biller-run
  // does for metered charges. Best-effort: a missing/locked db never blocks billing (override path with
  // ISUB_INDEX_DB; set ISUB_NO_INDEX=1 to skip the mirror entirely).
  const indexDb = process.env.ISUB_NO_INDEX ? null : openDb(process.env.ISUB_INDEX_DB ?? join(here, '..', `isub-index.${NETWORK}.db`));

  const keeper = new IsubKeeper(isub, signer, ids, {
    store,
    onEvent: (e) => {
      if (e.type === 'charge.succeeded') {
        console.log(`✓ charged ${e.mandateId.slice(0, 10)}… ${fmt(e.amount)} (${e.digest.slice(0, 10)}…)`);
        if (indexDb) try { recordCharge(indexDb, { mandateId: e.mandateId, amount: e.amount, seq: e.seq, digest: e.digest, atMs: e.at }); } catch { /* dashboard mirror is best-effort */ }
      }
      else if (e.type === 'charge.failed') console.log(`✗ ${e.mandateId.slice(0, 10)}… ${e.deterministic ? `abort #${e.abortCode}` : 'transient'}: ${e.error}`);
      else console.log(`⚡ ${e.type} ${e.mandateId.slice(0, 10)}…`);
    },
  });
  await keeper.init();

  // Auto-discovery: watch EVERY active, non-exhausted Fixed mandate on the given plan/merchant — and
  // re-scan every 15s so a wallet that subscribes later starts billing without restarting the keeper.
  // Reads the gateway index db (the relationship index gRPC can't build). This is how one keeper bills
  // a whole plan's subscribers; exhausted/paused/revoked/PAYG rows are skipped.
  const index = indexDb ? new IsubIndex(isub, indexDb) : null;
  const discover = (): void => {
    if (!index || (!planId && !merchant)) return;
    try {
      const rows = [...(planId ? index.mandatesByPlan(planId) : []), ...(merchant ? index.mandatesByMerchant(merchant) : [])];
      const known = new Set(keeper.watching());
      const fresh = [
        ...new Set(
          rows
            .filter((r) => r.mode === ChargeMode.Fixed && r.status === MandateStatus.Active && r.spentTotal < r.totalBudget)
            .map((r) => r.mandateId)
            .filter((id) => !known.has(id)),
        ),
      ];
      if (fresh.length) {
        keeper.watch(...fresh);
        console.log(`+ discovered ${fresh.length} mandate(s) to bill (${keeper.watching().length} total)`);
      }
    } catch (e) {
      console.log(`⚠️  discovery skipped: ${e instanceof Error ? e.message : e}`);
    }
  };
  discover();

  console.log(`iSub keeper ${signer.address} on ${NETWORK}`);
  console.log(`package ${packageId} ｜ store .keeper/${NETWORK}`);
  const watched = keeper.watching();
  if (watched.length === 0) console.log('⚠️  nothing to bill — pass `--plan 0x…` / `--merchant 0x…` or mandate ids');
  else console.log(`watching ${watched.length} mandate(s)${planId || merchant ? ' · auto-discovering new ones every 15s' : ''}`);
  console.log('polling every 1s (Ctrl-C to stop)\n');

  const ac = new AbortController();
  const refresh = planId || merchant ? setInterval(discover, 15_000) : null;
  process.on('SIGINT', () => {
    console.log('\nstopping…');
    if (refresh) clearInterval(refresh);
    ac.abort();
  });

  await keeper.run({ pollMs: 1000, signal: ac.signal });
}

main().catch((e) => {
  console.error('keeper crashed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

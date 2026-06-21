// scripts/backend.ts — the ALL-IN-ONE Railway backend. ONE process, ONE sqlite file (one volume):
//   • IsubGateway HTTP   — the dashboard read API (/relations, /usage, /charges, /report, ingest, discover)
//   • FIXED keeper loop  — auto-watches Active FIXED mandates from the index and charges them on interval
//   • PAYG auto-bill loop— pulls a small metered charge per Active PAYG mandate (simulated usage)
// Mandates enter the index when users subscribe (checkout ingests) — so subscribe → auto-charge → cancel
// all work in the cloud with no local CLI. Charges only fire for mandates whose authorized_keeper is THIS
// keeper (our demo plans); a judge's own plan with their own keeper won't auto-charge (contract design).
//
// The keeper signing key comes from ISUB_KEEPER_KEY (a Railway secret — bech32 suiprivkey), else the
// local .secrets actor. Run: PORT=4100 ISUB_NETWORK=testnet ISUB_KEEPER_KEY=… NODE_OPTIONS=--experimental-sqlite tsx scripts/backend.ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubClient, IsubKeeper, keypairSigner } from '../src/index';
import { IsubService } from '../src/service';
import { IsubGateway } from '../src/gateway';
import { IsubIndex } from '../src/relations';
import { openDb } from '../src/db';
import { sqlBillerStore } from '../src/sql-store';
import { fileStore } from '../src/store-file';
import { ChargeMode, MandateStatus } from '../src/constants';
import { clientFor, loadOrCreateActor, loadDeployment, baseUrlFor, fmt, NETWORK } from './env';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4100);
const DB_PATH = process.env.ISUB_INDEX_DB ?? join(here, '..', `isub-index.${NETWORK}.db`);
const PAYG_TICK_MS = Number(process.env.ISUB_PAYG_TICK_MS ?? 15_000); // bill each Active PAYG mandate this often
const PAYG_AMOUNT = BigInt(process.env.ISUB_PAYG_AMOUNT ?? 2_000_000); // 0.002 SUI per PAYG bill tick (simulated usage)
const DISCOVER_MS = 10_000;

function keeperKeypair(): Ed25519Keypair {
  const k = process.env.ISUB_KEEPER_KEY;
  return k ? Ed25519Keypair.fromSecretKey(k.trim()) : loadOrCreateActor('keeper', NETWORK);
}

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const db = openDb(DB_PATH);
  const keeper = keypairSigner(keeperKeypair(), client);
  const log = (...a: unknown[]): void => console.log('[backend]', ...a);

  // 1) gateway HTTP — read API + report + ingest + chain discovery (read-only: routing → null).
  const index = new IsubIndex(isub, db);
  const gateway = new IsubGateway({
    chain: isub, keeperSigner: keeper, db, policy: { windowMs: 3_600_000 },
    routing: () => null, index, network: NETWORK, rpcUrl: baseUrlFor(NETWORK), packageId,
  });
  gateway.listen(PORT);
  log(`gateway on :${PORT} · network ${NETWORK} · db ${DB_PATH} · keeper ${keeper.address.slice(0, 12)}…`);

  // 2) FIXED keeper — charges watched FIXED mandates on their interval. Bridge each charge into the
  //    chart's journal (the keeper uses its own KeeperStore) so FIXED also shows on the UsageChart.
  const chartBridge = sqlBillerStore(db, 'fixed-keeper');
  const keeperEngine = new IsubKeeper(isub, keeper, [], {
    store: fileStore(join(dirname(DB_PATH), '.keeper', NETWORK)),
    onEvent: (e) => {
      if (e.type === 'charge.succeeded') {
        log(`FIXED charged ${fmt(e.amount)} → ${e.mandateId.slice(0, 10)}… (${String(e.digest).slice(0, 10)}…)`);
        const at = Date.now();
        void chartBridge.recordUsage({ usageId: `fx-${e.mandateId.slice(2, 10)}-${at}`, mandateId: e.mandateId, amount: e.amount, atMs: at }).catch(() => {});
        void chartBridge.appendJournal({ at, mandateId: e.mandateId, kind: 'charged', amount: e.amount.toString(), digest: e.digest }).catch(() => {});
      } else if (e.type === 'charge.failed') {
        log(`FIXED charge failed ${e.mandateId.slice(0, 10)}…: ${e.error}`);
      }
    },
  });
  await keeperEngine.init();
  void keeperEngine.run({ pollMs: 1000 });

  // 3) PAYG biller — one IsubService per merchant (payout must equal mandate.merchant). The auto-bill
  //    loop pulls a small metered charge per Active PAYG mandate (simulated metered usage); writes land
  //    in this same db → the dashboard's UsageChart + /report pick them up.
  const paygByMerchant = new Map<string, IsubService>();
  const paygSvc = (merchant: string): IsubService => {
    let s = paygByMerchant.get(merchant);
    if (!s) {
      s = new IsubService(isub, keeper, merchant, sqlBillerStore(db, `payg-${merchant.slice(2, 10)}`), { windowMs: 3_600_000, agentAuth: 'off' });
      paygByMerchant.set(merchant, s);
    }
    return s;
  };

  // Discovery: auto-watch FIXED mandates; collect PAYG mandates (→ merchant) for the bill loop.
  const watchedFixed = new Set<string>();
  const paygMandates = new Map<string, string>(); // mandateId → merchant
  const discover = (): void => {
    try {
      const rows = db.prepare('SELECT mandate_id, merchant, mode, status FROM idx_mandates').all() as { mandate_id: string; merchant: string; mode: number; status: number }[];
      for (const r of rows) {
        if (r.status !== MandateStatus.Active) {
          watchedFixed.delete(r.mandate_id) && keeperEngine.unwatch(r.mandate_id);
          paygMandates.delete(r.mandate_id);
          continue;
        }
        if (r.mode === ChargeMode.Fixed && !watchedFixed.has(r.mandate_id)) {
          watchedFixed.add(r.mandate_id);
          keeperEngine.watch(r.mandate_id);
          log(`watch FIXED ${r.mandate_id.slice(0, 10)}…`);
        }
        if (r.mode === ChargeMode.Payg && !paygMandates.has(r.mandate_id)) {
          paygMandates.set(r.mandate_id, r.merchant);
          log(`bill PAYG ${r.mandate_id.slice(0, 10)}… (every ${PAYG_TICK_MS / 1000}s)`);
        }
      }
    } catch (e) {
      log('discover error:', e instanceof Error ? e.message : e);
    }
  };
  discover();
  setInterval(discover, DISCOVER_MS);

  // PAYG auto-bill tick
  setInterval(() => {
    void (async (): Promise<void> => {
      for (const [mandateId, merchant] of [...paygMandates]) {
        try {
          const svc = paygSvc(merchant);
          const r = await svc.use(mandateId, PAYG_AMOUNT, `auto-${mandateId.slice(2, 10)}-${Date.now()}`, undefined, 'off');
          if (r.ok) {
            await svc.flush(mandateId);
            log(`PAYG billed ${fmt(PAYG_AMOUNT)} → ${mandateId.slice(0, 10)}…`);
          } else if (r.status === 402) {
            paygMandates.delete(mandateId); // out of budget / balance → stop billing it
            log(`PAYG ${mandateId.slice(0, 10)}… exhausted (${r.reason}) — stop`);
          }
        } catch (e) {
          log(`PAYG bill error ${mandateId.slice(0, 10)}…:`, e instanceof Error ? e.message : e);
        }
      }
    })();
  }, PAYG_TICK_MS);

  log(`charging live — FIXED via keeper (per-mandate interval) · PAYG auto-bill ${fmt(PAYG_AMOUNT)} every ${PAYG_TICK_MS / 1000}s`);
}

main().catch((e) => { console.error('backend failed:', e instanceof Error ? e.message : e); process.exit(1); });

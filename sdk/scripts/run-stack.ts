// Bring up the iSub OPERATOR backend as one supervised process group:
//   • gateway  — off-chain relationship index + public API (/relations, /usage, /charges, /report,
//                ingest). The web app proxies /gw here. Always started.
//   • keeper   — charges FIXED subscription mandates when they are genuinely DUE (real recurring
//                billing), auto-discovering every active Fixed mandate on a plan/merchant.
//   • biller   — OPTIONAL. Settles REAL accrued PAYG usage (flush-only). PAYG is normally charged by
//                your own metered service per real call; run this only for the record-then-settle model.
//   • web      — OPTIONAL Next dashboard (ISUB_WITH_WEB=1).
//
// NOT a demo: nothing here fabricates usage. The keeper bills Fixed plans on their interval; the biller
// only settles usage a service actually recorded. Ctrl-C tears the whole group down cleanly.
//
// Config (env):
//   ISUB_NETWORK   network            (default 'testnet')
//   GATEWAY_PORT   gateway port       (default 4100 — the web /gw proxy points here)
//   ISUB_INDEX_DB  shared SQLite path (default sdk/isub-index.<network>.db — gateway + keeper + biller share it)
//   ISUB_MERCHANT  merchant address whose FIXED subscriptions the keeper bills   (or ISUB_PLAN)
//   ISUB_PLAN      scope the keeper to a single plan id instead of a merchant
//   ISUB_PAYG      a PAYG mandate id → also run the flush-only biller (needs .secrets/<net>/keeper.key)
//   ISUB_WITH_WEB  '1' → also start the Next dashboard (web/)
//
// Run:  ISUB_NETWORK=testnet ISUB_MERCHANT=0x… npm run stack
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdk = join(here, '..');
const tsxBin = join(sdk, 'node_modules', '.bin', 'tsx');

const NETWORK = process.env.ISUB_NETWORK ?? 'testnet';
const GATEWAY_PORT = process.env.GATEWAY_PORT ?? '4100';
const INDEX_DB = process.env.ISUB_INDEX_DB ?? join(sdk, `isub-index.${NETWORK}.db`);
// Children that open the SQLite index need --experimental-sqlite; the gateway/keeper/biller all do.
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ISUB_NETWORK: NETWORK,
  ISUB_INDEX_DB: INDEX_DB,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --experimental-sqlite`.trim(),
};

const COLOR: Record<string, string> = { stack: '\x1b[1m', gateway: '\x1b[36m', keeper: '\x1b[32m', biller: '\x1b[33m', web: '\x1b[35m' };
const log = (name: string, line: string): void => { process.stdout.write(`${COLOR[name] ?? ''}[${name}]\x1b[0m ${line}\n`); };
const pipe = (name: string, cp: ChildProcess): void => {
  const out = (b: Buffer): void => String(b).split('\n').filter(Boolean).forEach((l) => log(name, l));
  cp.stdout?.on('data', out);
  cp.stderr?.on('data', out);
};

interface Proc { name: string; cp: ChildProcess; critical: boolean }
const procs: Proc[] = [];
let shuttingDown = false;

/** Spawn a component in its OWN process group (detached) so we can SIGTERM the whole tree on exit. */
function start(name: string, cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; critical?: boolean } = {}): void {
  log('stack', `starting ${name}…`);
  const cp = spawn(cmd, args, { cwd: opts.cwd ?? sdk, env: { ...baseEnv, ...opts.env }, detached: true });
  pipe(name, cp);
  cp.on('exit', (code, sig) => {
    log('stack', `${name} exited (code ${code ?? '—'}${sig ? `, ${sig}` : ''})`);
    if (!shuttingDown && opts.critical) {
      log('stack', `${name} is critical — tearing down the rest`);
      shutdown(1);
    }
  });
  procs.push({ name, cp, critical: !!opts.critical });
}

function shutdown(exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('stack', `stopping ${procs.length} component(s)…`);
  for (const { cp } of procs) { try { if (cp.pid) process.kill(-cp.pid, 'SIGTERM'); } catch { /* already gone */ } }
  setTimeout(() => {
    for (const { cp } of procs) { try { if (cp.pid) process.kill(-cp.pid, 'SIGKILL'); } catch { /* gone */ } }
    log('stack', 'stopped.');
    process.exit(exitCode);
  }, 4000);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitForGateway(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`http://localhost:${GATEWAY_PORT}/health`)).ok) return true; } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 1000));
  }
  return false;
}

async function main(): Promise<void> {
  log('stack', `network=${NETWORK}  gateway=:${GATEWAY_PORT}  db=${INDEX_DB}`);

  // 1) Gateway — always (the index/API everything else + the web app depend on).
  start('gateway', tsxBin, [join(sdk, 'scripts', 'gateway-serve.ts')], { env: { PORT: GATEWAY_PORT }, critical: true });
  log('stack', await waitForGateway() ? 'gateway healthy ✓' : '⚠️ gateway health not confirmed (continuing)');

  // 2) Keeper — FIXED subscription billing (auto-discovers + refreshes; charges only when due).
  if (process.env.ISUB_PLAN) start('keeper', tsxBin, [join(sdk, 'scripts', 'keeper.ts'), '--plan', process.env.ISUB_PLAN], { critical: true });
  else if (process.env.ISUB_MERCHANT) start('keeper', tsxBin, [join(sdk, 'scripts', 'keeper.ts'), '--merchant', process.env.ISUB_MERCHANT], { critical: true });
  else log('stack', '⚠️ keeper NOT started — set ISUB_MERCHANT=0x… or ISUB_PLAN=0x… to bill FIXED subscriptions');

  // 3) Biller — settle REAL accrued PAYG usage (flush-only; never fabricates usage). Optional.
  if (process.env.ISUB_PAYG) start('biller', tsxBin, [join(sdk, 'scripts', 'biller-run.ts'), process.env.ISUB_PAYG, '--flush-only']);
  else log('stack', 'ℹ️ PAYG biller not started — PAYG is charged by your metered service per real call. Set ISUB_PAYG=0x<mandate> for flush-only settlement of recorded usage.');

  // 4) Web dashboard — optional.
  if (process.env.ISUB_WITH_WEB === '1') {
    start('web', 'npm', ['run', 'dev'], { cwd: join(sdk, '..', 'web'), env: { GATEWAY_ORIGIN: `http://localhost:${GATEWAY_PORT}` } });
  }

  log('stack', 'up — Ctrl-C to stop everything');
}

main().catch((e) => { log('stack', `fatal: ${e instanceof Error ? e.message : e}`); shutdown(1); });

// Long-running keeper: bills the WATCHED Fixed mandates with the full state machine
// (past_due → recovered | lapsed), durable store, and journal under .keeper/<network>.
// Pass mandate ids to watch as args — they merge into the persisted watch set, so a
// restart resumes where it left off (a merchant backend would call watch() instead).
// Run: `npm run keeper -- 0x<mandateId> …`   (ISUB_NETWORK=testnet for testnet)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsubClient, IsubKeeper, keypairSigner } from '../src/index';
import { fileStore } from '../src/store-file';
import { clientFor, actor, loadDeployment, fmt, NETWORK } from './env';

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => a.startsWith('0x'));
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });

  const keeperKp = await actor(client, 'keeper');
  const signer = keypairSigner(keeperKp, client);
  const here = dirname(fileURLToPath(import.meta.url));
  const store = fileStore(join(here, '..', '.keeper', NETWORK));

  const keeper = new IsubKeeper(isub, signer, ids, {
    store,
    onEvent: (e) => {
      if (e.type === 'charge.succeeded') console.log(`✓ charged ${e.mandateId.slice(0, 10)}… ${fmt(e.amount)} (${e.digest.slice(0, 10)}…)`);
      else if (e.type === 'charge.failed') console.log(`✗ ${e.mandateId.slice(0, 10)}… ${e.deterministic ? `abort #${e.abortCode}` : 'transient'}: ${e.error}`);
      else console.log(`⚡ ${e.type} ${e.mandateId.slice(0, 10)}…`);
    },
  });
  await keeper.init();

  console.log(`iSub keeper ${signer.address} on ${NETWORK}`);
  console.log(`package ${packageId} ｜ store .keeper/${NETWORK}`);
  const watched = keeper.watching();
  if (watched.length === 0) console.log('⚠️  watch set is empty — pass ids: `npm run keeper -- 0x…`');
  else console.log(`watching ${watched.length} mandate(s)`);
  console.log('polling every 1s (Ctrl-C to stop)\n');

  const ac = new AbortController();
  process.on('SIGINT', () => {
    console.log('\nstopping…');
    ac.abort();
  });

  await keeper.run({ pollMs: 1000, signal: ac.signal });
}

main().catch((e) => {
  console.error('keeper crashed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

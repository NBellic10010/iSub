// Pre-fund the persistent actors for a public network. Tries the faucet first;
// if that's gated (testnet), you fund ONE address — the `publisher` (funder) — from
// your wallet, and this script disperses to subscriber / merchant / keeper.
// Run: `npm run fund:testnet` (re-run after funding the funder).
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import { clientFor, loadOrCreateActor, suiBalance, sleep, fmt, faucetHostFor, explorer, NETWORK } from './env';

const FUNDER = 'publisher'; // funder + publisher are the same business-side key
const RECIPIENTS = ['subscriber', 'merchant', 'keeper'] as const;
const TARGET = MIST_PER_SUI / 2n; // 0.5 SUI each
const GAS_BUFFER = MIST_PER_SUI / 20n; // 0.05 SUI kept for the disperse tx

async function main(): Promise<void> {
  if (NETWORK === 'localnet') {
    console.log('localnet faucet is unlimited — no pre-funding needed.');
    return;
  }
  const client = clientFor();
  const ex = explorer();

  const funder = loadOrCreateActor(FUNDER);
  const recipients = RECIPIENTS.map((name) => {
    const kp = loadOrCreateActor(name);
    return { name, addr: kp.toSuiAddress() };
  });

  // Best-effort faucet for everyone (testnet usually rejects — that's fine).
  const all = [{ name: FUNDER, addr: funder.toSuiAddress() }, ...recipients];
  for (const a of all) {
    if ((await suiBalance(client, a.addr)) >= TARGET) continue;
    try {
      await requestSuiFromFaucetV2({ host: faucetHostFor(NETWORK), recipient: a.addr });
      await sleep(1500);
    } catch {
      /* gated — fall through to wallet funding */
    }
  }

  console.log(`• ${NETWORK} actors (target ${fmt(TARGET)} each)\n`);
  const funderBal = await suiBalance(client, funder.toSuiAddress());
  console.log(`  ${'publisher (funder)'.padEnd(18)} ${funder.toSuiAddress()}  ${fmt(funderBal)}`);
  const short: { name: string; addr: string; need: bigint }[] = [];
  for (const r of recipients) {
    const bal = await suiBalance(client, r.addr);
    console.log(`  ${r.name.padEnd(18)} ${r.addr}  ${fmt(bal)}`);
    if (bal < TARGET) short.push({ name: r.name, addr: r.addr, need: TARGET - bal });
  }

  if (short.length === 0 && funderBal >= TARGET) {
    console.log('\n✅ all actors funded.');
    return;
  }

  // Need to disperse from the funder — check it holds enough (its own TARGET + the gaps + gas).
  const disperse = short.reduce((s, x) => s + x.need, 0n);
  const funderNeed = TARGET + disperse + GAS_BUFFER;
  if (funderBal < funderNeed) {
    const ask = funderNeed - funderBal;
    console.log(`\n⚠️  faucet is gated. Fund the FUNDER once from your wallet, then re-run \`npm run fund:testnet\`:`);
    console.log(`\n     send ${fmt(ask)} (or more) to  ${funder.toSuiAddress()}`);
    console.log(`\n  it then disperses ${fmt(TARGET)} to each of ${RECIPIENTS.join(' / ')}.`);
    console.log(`  explorer: ${ex.account(funder.toSuiAddress())}`);
    process.exit(1);
  }

  console.log(`\n• dispersing from publisher → ${short.map((s) => s.name).join(', ')}…`);
  const tx = new Transaction();
  tx.setSenderIfNotSet(funder.toSuiAddress());
  const coins = tx.splitCoins(tx.gas, short.map((s) => s.need));
  short.forEach((s, i) => tx.transferObjects([coins[i]!], s.addr));
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer: funder, include: { effects: true } });
  const t = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  if (res.$kind !== 'Transaction' || !t.status.success) {
    throw new Error(`disperse failed: ${JSON.stringify(t.status.error)}`);
  }
  await client.waitForTransaction({ digest: t.digest });
  console.log(`  ✓ ${ex.tx(t.digest)}`);
  console.log('\n✅ all actors funded.');
}

main().catch((e) => {
  console.error('fund failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

// Spike probe for the Payment-Kit variant: run one real charge against a given
// package and show that it emits an on-chain `payment_kit::PaymentReceipt` event —
// i.e. the merchant payout actually routed through the official Sui Payment Kit.
// Usage: ISUB_NETWORK=testnet npx tsx scripts/pk-receipt-probe.ts <pkVariantPackageId>
import { IsubClient, keypairSigner } from '../src/index';
import { clientFor, actor, loadDeployment, NETWORK } from './env';

const SUI = 1_000_000_000n;
const PRICE = SUI / 20n; // 0.05
const DEPOSIT = SUI / 10n; // 0.1
const INTERVAL_MS = 60_000n;

async function main(): Promise<void> {
  const client = clientFor();
  const packageId = process.argv[2] ?? loadDeployment().packageId;
  const isub = new IsubClient({ client, packageId });
  console.log(`• package ${packageId} on ${NETWORK}`);

  const [subKp, merKp, keeKp] = await Promise.all([
    actor(client, 'subscriber'),
    actor(client, 'merchant'),
    actor(client, 'keeper'),
  ]);
  const subscriber = keypairSigner(subKp, client);
  const merchant = keypairSigner(merKp, client);
  const keeper = keypairSigner(keeKp, client);

  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  const { planId } = await isub.createPlanFixed(merchant, { price: PRICE, intervalMs: INTERVAL_MS, keeper: keeper.address });
  const expiryMs = BigInt(Date.now() + 60 * 60 * 1000);
  const { mandateId } = await isub.authorizeFixed(subscriber, {
    accountId,
    planId,
    expectedPrice: PRICE,
    expectedIntervalMs: INTERVAL_MS,
    expectedMerchant: merchant.address,
    totalBudget: PRICE,
    expiryMs,
  });
  const { digest } = await isub.charge(keeper, { accountId, mandateId, amount: PRICE });
  console.log(`• charge digest ${digest}`);

  const res = await client.getTransaction({ digest, include: { events: true } });
  const t = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  const evs = t.events ?? [];
  console.log(`• ${evs.length} event(s) emitted by the charge:`);
  for (const e of evs) console.log(`   - ${e.eventType}`);

  const receipt = evs.find((e) => e.eventType.includes('::payment_kit::PaymentReceipt'));
  if (!receipt) throw new Error('✗ no PaymentReceipt event — charge did NOT route through Payment Kit');
  console.log('\n✅ official Sui Payment Kit receipt emitted on-chain by our charge:');
  console.log('   ' + JSON.stringify(receipt.json));
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});

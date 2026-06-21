// Compliance report builder smoke (pure; no chain, no sqlite). Proves: month filtering ([start,end)),
// subscriber-vs-merchant counterparty direction, totals + per-counterparty subtotals, and the CSV
// shape (metadata preamble, header, one row per in-period charge, suiscan audit links for real
// digests only). Run: npx tsx scripts/compliance-smoke.ts
import {
  buildComplianceReport,
  reportToCsv,
  monthRangeUtc,
  monthRangeFromLabel,
  currentMonthUtc,
  formatUnits,
  type MandateLite,
  type ChargeLite,
} from '../src/compliance';

let checks = 0;
const check = (c: boolean, label: string): void => { if (!c) throw new Error('✗ ' + label); checks++; console.log('  ✓ ' + label); };

const SUI = 1_000_000_000n;
const SUB = '0xsub';
const MA = '0xmerchantA';
const MB = '0xmerchantB';
const REAL_A = 'AAAAAAAAAAAAAAAAAAAA1111'; // looks like a real tx digest (>=20 alnum)
const REAL_B = 'BBBBBBBBBBBBBBBBBBBB2222';

const mandates: MandateLite[] = [
  { mandateId: 'M1', merchant: MA, subscriber: SUB, planId: 'P1' },
  { mandateId: 'M2', merchant: MB, subscriber: SUB, planId: 'P2' },
];
const may = Date.UTC(2026, 4, 15); // 2026-05-15
const jun1 = Date.UTC(2026, 5, 10);
const jun2 = Date.UTC(2026, 5, 20);
const apr = Date.UTC(2026, 3, 1);
const charges: ChargeLite[] = [
  { mandateId: 'M1', amount: 1n * SUI, seq: 1, digest: REAL_A, atMs: may }, // May — excluded from a June report
  { mandateId: 'M1', amount: 2n * SUI, seq: 2, digest: 'recovered', atMs: jun1 }, // June, reconciled-without-ack
  { mandateId: 'M2', amount: SUI / 2n, seq: 1, digest: REAL_B, atMs: jun2 }, // June, real digest
  { mandateId: 'M2', amount: 9n, seq: 0, digest: null, atMs: apr }, // April — excluded
];

function main(): void {
  console.log('• month ranges');
  const r = monthRangeUtc(2026, 6);
  check(r.label === '2026-06' && r.startMs === Date.UTC(2026, 5, 1) && r.endMs === Date.UTC(2026, 6, 1), 'monthRangeUtc(2026,6) → [Jun 1, Jul 1)');
  check(monthRangeFromLabel('2026-06').startMs === r.startMs, "monthRangeFromLabel('2026-06') matches");
  check(currentMonthUtc(Date.UTC(2026, 5, 15)).label === '2026-06', 'currentMonthUtc(mid-June) → 2026-06');
  let threw = false;
  try { monthRangeFromLabel('2026-13'); } catch { threw = true; }
  check(threw, 'monthRangeFromLabel rejects month 13');
  check(formatUnits(2_500_000_000n, 9) === '2.5' && formatUnits(2n * SUI, 9) === '2' && formatUnits(SUI / 2n, 9) === '0.5', 'formatUnits trims trailing zeros');

  console.log('\n• subscriber report (payments made), June 2026');
  const sub = buildComplianceReport({
    party: 'subscriber', address: SUB, asset: '0x2::sui::SUI', network: 'testnet',
    periodStartMs: r.startMs, periodEndMs: r.endMs, periodLabel: r.label, generatedAtMs: Date.UTC(2026, 6, 1),
    mandates, charges,
  });
  check(sub.count === 2, 'only the 2 June charges included (May + April dropped)');
  check(sub.total === 2_500_000_000n, 'total = 2 + 0.5 = 2.5 SUI');
  check(sub.rows.every((row) => row.counterparty === MA || row.counterparty === MB), 'subscriber report counterparty = merchant');
  check(sub.rows[0]!.atMs === jun1 && sub.rows[1]!.atMs === jun2, 'rows sorted oldest-first');
  check(sub.byCounterparty[0]!.counterparty === MA && sub.byCounterparty[0]!.total === 2n * SUI, 'byCounterparty sorted by total desc (MA=2 first)');

  console.log('\n• merchant report (payments received) for MA, June 2026');
  const merch = buildComplianceReport({
    party: 'merchant', address: MA, asset: '0x2::sui::SUI', network: 'testnet',
    periodStartMs: r.startMs, periodEndMs: r.endMs, periodLabel: r.label, generatedAtMs: Date.UTC(2026, 6, 1),
    mandates: mandates.filter((m) => m.merchant === MA), charges: charges.filter((c) => c.mandateId === 'M1'),
  });
  check(merch.count === 1 && merch.total === 2n * SUI, 'MA received exactly the 1 June charge (2 SUI)');
  check(merch.rows[0]!.counterparty === SUB, 'merchant report counterparty = subscriber (payer)');

  console.log('\n• CSV shape + audit links');
  const csv = reportToCsv(sub, { explorerTxBase: 'https://suiscan.xyz/testnet/tx/' });
  check(csv.includes('# iSub compliance report,payments made (subscriber)'), 'CSV metadata: report type');
  check(csv.includes('# period,2026-06') && csv.includes('# total_amount,2.5') && csv.includes('# total_amount_base_units,2500000000'), 'CSV metadata: period + totals');
  const lines = csv.split('\n');
  const header = lines.find((l) => l.startsWith('date_utc,'))!;
  check(header.includes('paid_to_merchant') && header.includes('tx_digest') && header.includes('explorer_url'), 'CSV header columns (subscriber direction + audit cols)');
  const dataRows = lines.filter((l) => l && !l.startsWith('#') && !l.startsWith('date_utc,'));
  check(dataRows.length === 2, 'CSV has exactly 2 data rows');
  check(csv.includes('https://suiscan.xyz/testnet/tx/' + REAL_B), 'real digest → suiscan audit URL');
  check(!csv.includes('tx/recovered'), "reconciled ('recovered') digest → no fake audit URL");

  console.log(`\n✅ compliance smoke passed — ${checks} assertions (month filter · direction · totals · CSV + audit links).`);
}

main();

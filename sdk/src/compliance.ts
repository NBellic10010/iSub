// `./compliance` — monthly compliance / reconciliation report for a SUBSCRIBER (payments made) or a
// MERCHANT (payments received). Assembled purely from the public on-chain settlement journal (each
// `charged` entry carries its tx digest = the audit anchor) joined to the relationship index
// (mandate → counterparty / plan). Pure + isomorphic (NO node:*): the same builder runs in the
// browser (download button), the gateway (HTTP export), or a CLI. Amounts are base units (MIST);
// `decimals` controls display formatting only.

export type ReportParty = 'subscriber' | 'merchant';

/** One settled charge in the period — an audit-grade line item. */
export interface ComplianceRow {
  atMs: number;
  dateUtc: string; // ISO-8601 (UTC) instant of settlement
  counterparty: string; // who was paid (subscriber report) / who paid (merchant report)
  mandateId: string;
  planId: string;
  amount: bigint; // base units (e.g. MIST)
  seq: number | null; // on-chain charge sequence (idempotency / audit)
  digest: string | null; // on-chain tx digest (audit anchor); 'recovered' or null for reconciled-without-ack
}

export interface ComplianceReport {
  party: ReportParty;
  address: string; // the party's address (subscriber wallet | merchant payout)
  asset: string; // e.g. '0x2::sui::SUI'
  decimals: number; // display decimals for `asset` (SUI = 9)
  network?: string;
  periodStartMs: number; // inclusive
  periodEndMs: number; // exclusive
  periodLabel: string; // 'YYYY-MM'
  generatedAtMs: number;
  rows: ComplianceRow[];
  total: bigint; // Σ amount over rows
  count: number;
  byCounterparty: { counterparty: string; total: bigint; count: number }[];
}

/** Index-shaped inputs (a `MandateRow` and a `ChargePoint` satisfy these structurally). */
export interface MandateLite { mandateId: string; merchant: string; subscriber: string; planId: string }
export interface ChargeLite { mandateId: string; amount: bigint | null; seq: number | null; digest: string | null; atMs: number }

/** UTC calendar-month `[start, end)` for a 1-based month. `label` = 'YYYY-MM'. */
export function monthRangeUtc(year: number, month1to12: number): { startMs: number; endMs: number; label: string } {
  if (month1to12 < 1 || month1to12 > 12) throw new Error(`bad month ${month1to12} — expected 1..12`);
  const startMs = Date.UTC(year, month1to12 - 1, 1);
  const endMs = Date.UTC(month1to12 === 12 ? year + 1 : year, month1to12 === 12 ? 0 : month1to12, 1);
  return { startMs, endMs, label: `${year}-${String(month1to12).padStart(2, '0')}` };
}

/** Parse 'YYYY-MM' → its UTC month range. */
export function monthRangeFromLabel(label: string): { startMs: number; endMs: number; label: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) throw new Error(`bad month '${label}' — expected YYYY-MM`);
  return monthRangeUtc(Number(m[1]), Number(m[2]));
}

/** The current UTC calendar month for a given instant (defaults to now). */
export function currentMonthUtc(nowMs: number = Date.now()): { startMs: number; endMs: number; label: string } {
  const d = new Date(nowMs);
  return monthRangeUtc(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/**
 * Build a report from the party's mandates + the charges across them. Charges OUTSIDE
 * `[periodStartMs, periodEndMs)`, or whose mandate isn't in `mandates`, are dropped. Sorted oldest-first.
 */
export function buildComplianceReport(input: {
  party: ReportParty;
  address: string;
  asset: string;
  decimals?: number;
  network?: string;
  periodStartMs: number;
  periodEndMs: number;
  periodLabel: string;
  generatedAtMs: number;
  mandates: MandateLite[];
  charges: ChargeLite[];
}): ComplianceReport {
  const byId = new Map(input.mandates.map((m) => [m.mandateId, m]));
  const rows: ComplianceRow[] = [];
  for (const c of input.charges) {
    if (c.atMs < input.periodStartMs || c.atMs >= input.periodEndMs) continue;
    const m = byId.get(c.mandateId);
    if (!m) continue; // charge for a mandate outside this party's set — skip
    rows.push({
      atMs: c.atMs,
      dateUtc: new Date(c.atMs).toISOString(),
      counterparty: input.party === 'subscriber' ? m.merchant : m.subscriber,
      mandateId: c.mandateId,
      planId: m.planId,
      amount: c.amount ?? 0n,
      seq: c.seq,
      digest: c.digest,
    });
  }
  rows.sort((a, b) => a.atMs - b.atMs || a.mandateId.localeCompare(b.mandateId) || (a.seq ?? 0) - (b.seq ?? 0));

  const total = rows.reduce((s, r) => s + r.amount, 0n);
  const cp = new Map<string, { total: bigint; count: number }>();
  for (const r of rows) {
    const e = cp.get(r.counterparty) ?? { total: 0n, count: 0 };
    e.total += r.amount;
    e.count++;
    cp.set(r.counterparty, e);
  }
  const byCounterparty = [...cp.entries()]
    .map(([counterparty, e]) => ({ counterparty, total: e.total, count: e.count }))
    .sort((a, b) => (b.total === a.total ? 0 : b.total > a.total ? 1 : -1));

  return {
    party: input.party,
    address: input.address,
    asset: input.asset,
    decimals: input.decimals ?? 9,
    network: input.network,
    periodStartMs: input.periodStartMs,
    periodEndMs: input.periodEndMs,
    periodLabel: input.periodLabel,
    generatedAtMs: input.generatedAtMs,
    rows,
    total,
    count: rows.length,
    byCounterparty,
  };
}

/** Format base units as a decimal string with `decimals` places, trailing zeros trimmed. */
export function formatUnits(base: bigint, decimals: number): string {
  if (decimals <= 0) return base.toString();
  const neg = base < 0n;
  const a = neg ? -base : base;
  const d = 10n ** BigInt(decimals);
  const whole = a / d;
  const frac = (a % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render a report as CSV: a `#`-prefixed metadata preamble (skipped by most parsers, readable in
 * Excel), a blank line, then the transaction table. Pass `explorerTxBase` to add a clickable
 * per-row audit URL (e.g. `https://suiscan.xyz/testnet/tx/`).
 */
export function reportToCsv(r: ComplianceReport, opts?: { explorerTxBase?: string }): string {
  const out: string[] = [];
  const meta = (k: string, v: string | number): void => { out.push(`# ${csvCell(k)},${csvCell(v)}`); };
  meta('iSub compliance report', r.party === 'subscriber' ? 'payments made (subscriber)' : 'payments received (merchant)');
  meta('address', r.address);
  meta('period', r.periodLabel);
  meta('period_start_utc', new Date(r.periodStartMs).toISOString());
  meta('period_end_utc_exclusive', new Date(r.periodEndMs).toISOString());
  meta('generated_at_utc', new Date(r.generatedAtMs).toISOString());
  if (r.network) meta('network', r.network);
  meta('asset', r.asset);
  meta('total_charges', r.count);
  meta('total_amount', formatUnits(r.total, r.decimals));
  meta('total_amount_base_units', r.total.toString());
  out.push('');

  const amountCol = r.party === 'subscriber' ? 'paid_to_merchant' : 'paid_by_subscriber';
  const header = ['date_utc', amountCol, 'mandate_id', 'plan_id', 'amount', 'amount_base_units', 'charge_seq', 'tx_digest'];
  if (opts?.explorerTxBase) header.push('explorer_url');
  out.push(header.map(csvCell).join(','));

  const isDigest = (d: string | null): d is string => !!d && /^[A-Za-z0-9]{20,}$/.test(d); // a real tx hash, not 'recovered'/null
  for (const row of r.rows) {
    const cells: (string | number)[] = [row.dateUtc, row.counterparty, row.mandateId, row.planId, formatUnits(row.amount, r.decimals), row.amount.toString(), row.seq ?? '', row.digest ?? ''];
    if (opts?.explorerTxBase) cells.push(isDigest(row.digest) ? `${opts.explorerTxBase}${row.digest}` : '');
    out.push(cells.map(csvCell).join(','));
  }
  return out.join('\n') + '\n';
}

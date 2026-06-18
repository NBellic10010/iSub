// PAYG pricing layer — turn a usage QUANTITY into a FROZEN bigint base-unit (MIST) amount.
//
// This module is PURE (no node:*, like exposure/lag) and sits STRICTLY UPSTREAM of the
// biller: `recordMeteredUsage` prices ONCE at ingest, freezes the bigint, and hands it to
// the unchanged `recordUsage(amount)` dedup path. The RateCard is never read again, so a
// mid-window price change can't re-price already-ingested usage and break reconciliation
// (see biller.ts recoverOrphan, which matches a whole-record prefix-sum to the journaled
// amount). All money + quantities are bigint — no floating point ever touches the price path.
import { ChargeMode } from './constants';
import { IsubError } from './errors';
import type { MandateState } from './types';

/** Rounding for the rational→bigint collapse. Card-level default; per-meter override allowed. */
export type Rounding = 'ceil' | 'floor' | 'half_up';

/**
 * An exact rational unit price: `priceNum` base-units (MIST) per `(priceDen * units)` of qty.
 *   3 MIST / 1000 tokens → { priceNum: 3n, priceDen: 1000n, units: 1n }
 *   500 MIST / call      → { priceNum: 500n, priceDen: 1n, units: 1n }
 */
export interface Meter {
  /** Stable provenance key the caller reports against, e.g. 'tokens.in' | 'calls' | 'gb'. Non-empty. */
  key: string;
  /** Unit-price numerator (MIST), ≥ 0n. */
  priceNum: bigint;
  /** Unit-price denominator, > 0n (lets you express sub-MIST per unit). */
  priceDen: bigint;
  /** Quantity granularity: the price applies per this many qty, > 0n. */
  units: bigint;
  /** Free quota subtracted from qty BEFORE pricing (per-usageId, one-shot — NOT rolling). ≥ 0n. */
  includedQty?: bigint;
  /** Per-record floor (MIST), applied after rounding, ONLY to billable usage (eff > 0). ≥ 0n. */
  minCharge?: bigint;
  /** Per-meter rounding override; falls back to card.rounding, then 'ceil'. */
  rounding?: Rounding;
}

/** A frozen, versioned price list. The merchant owns and edits it (bump `version` on any change). */
export interface RateCard {
  /** Monotonic version; stored as per-row provenance ONLY — never re-priced from. */
  version: number;
  /** Card default rounding (a per-meter override wins). Default 'ceil'. */
  rounding?: Rounding;
  /** Meters keyed by `Meter.key`. */
  meters: Readonly<Record<string, Meter>>;
}

export interface PricedLine {
  meterKey: string;
  qty: bigint;
  amount: bigint;
}
export interface PriceResult {
  amount: bigint;
  lines: PricedLine[];
  cardVersion: number;
}

export interface RateCardFitProblem {
  meterKey: string;
  code: 'min_exceeds_max_per_charge' | 'min_exceeds_rate_cap' | 'min_exceeds_budget_left' | 'unit_exceeds_max_per_charge' | 'not_payg';
  detail: string;
}

/** u64 ceiling the chain enforces on a single charge amount; we fail loud at ingest instead of at flush. */
const U64_MAX = (1n << 64n) - 1n;

/** Pure non-negative integer division with an explicit rounding mode (a ≥ 0n, b > 0n). */
function roundDiv(a: bigint, b: bigint, mode: Rounding): bigint {
  if (mode === 'floor') return a / b;
  if (mode === 'half_up') return (2n * a + b) / (2n * b); // ties round up
  return (a + b - 1n) / b; // ceil (default)
}

/** Validate a card once (at construction). Throws `IsubError('config', …)` on any malformed meter. */
export function assertValidRateCard(card: RateCard): void {
  if (!card || typeof card.version !== 'number') throw new IsubError('config', 'rate card needs a numeric version');
  const entries = Object.entries(card.meters ?? {});
  if (entries.length === 0) throw new IsubError('config', 'rate card has no meters');
  for (const [slot, m] of entries) {
    if (!m.key) throw new IsubError('config', `meter slot "${slot}" has an empty key`);
    if (m.key !== slot) throw new IsubError('config', `meter key mismatch: slot "${slot}" holds key "${m.key}"`);
    if (m.priceDen <= 0n) throw new IsubError('config', `meter "${slot}": priceDen must be > 0`);
    if (m.units <= 0n) throw new IsubError('config', `meter "${slot}": units must be > 0`);
    if (m.priceNum < 0n) throw new IsubError('config', `meter "${slot}": priceNum must be >= 0`);
    if (m.includedQty !== undefined && m.includedQty < 0n) throw new IsubError('config', `meter "${slot}": includedQty must be >= 0`);
    if (m.minCharge !== undefined && m.minCharge < 0n) throw new IsubError('config', `meter "${slot}": minCharge must be >= 0`);
  }
}

/**
 * Price ONE meter's quantity to a frozen bigint MIST amount. Deterministic + integer-only.
 * `eff = max(0, qty - includedQty)`; within the free allowance (eff = 0) the line is free (0n) and
 * `minCharge` does NOT apply. Otherwise `amount = max(round(eff*priceNum / (priceDen*units)), minCharge)`.
 * Throws on an unknown meter, a negative qty, or a result over u64.
 */
export function priceUsage(card: RateCard, meterKey: string, qty: bigint): bigint {
  const m = card.meters[meterKey];
  if (!m) throw new IsubError('usage', `unknown meter "${meterKey}"`);
  if (qty < 0n) throw new IsubError('usage', `meter "${meterKey}": qty must be >= 0`);
  const included = m.includedQty ?? 0n;
  const eff = qty > included ? qty - included : 0n;
  if (eff === 0n) return 0n; // zero qty, or fully covered by the included allowance → free
  const mode = m.rounding ?? card.rounding ?? 'ceil';
  const raw = roundDiv(eff * m.priceNum, m.priceDen * m.units, mode);
  const min = m.minCharge ?? 0n;
  const amount = raw > min ? raw : min;
  if (amount > U64_MAX) throw new IsubError('usage', `meter "${meterKey}": priced amount exceeds u64`);
  return amount;
}

/**
 * Price one OR MORE `{ meterKey, qty }` lines into ONE frozen total + a per-line breakdown
 * (each line rounded independently, then summed — so lines are individually auditable and
 * sum exactly to `amount`). This is the single authoritative pricing call.
 */
export function priceUsageMulti(card: RateCard, items: ReadonlyArray<{ meterKey: string; qty: bigint }>): PriceResult {
  const lines: PricedLine[] = [];
  let amount = 0n;
  for (const it of items) {
    const a = priceUsage(card, it.meterKey, it.qty);
    lines.push({ meterKey: it.meterKey, qty: it.qty, amount: a });
    amount += a;
  }
  if (amount > U64_MAX) throw new IsubError('usage', 'priced total exceeds u64');
  return { amount, lines, cardVersion: card.version };
}

/**
 * ADVISORY liveness check — validate each meter's reachable single charge against the SAME
 * clamps `spendableNow` uses (rate_cap/window, max_per_charge, remaining budget; it correctly
 * OMITS the live account balance). Returns problems; an empty list means "nothing structurally
 * dead-on-arrival", NOT "everything settles" (legitimate bursts can still carry). The caller
 * decides warn vs reject; only `min_exceeds_max_per_charge` is a hard never-settles case.
 */
export function assertRateCardFits(
  card: RateCard,
  m: Pick<MandateState, 'mode' | 'rateCap' | 'rateWindowMs' | 'maxPerCharge' | 'totalBudget' | 'spentTotal'>,
): RateCardFitProblem[] {
  if (m.mode !== ChargeMode.Payg) return [{ meterKey: '*', code: 'not_payg', detail: 'rate cards apply to PAYG mandates only' }];
  const out: RateCardFitProblem[] = [];
  const budgetLeft = m.totalBudget > m.spentTotal ? m.totalBudget - m.spentTotal : 0n;
  for (const [k, meter] of Object.entries(card.meters)) {
    const min = meter.minCharge ?? 0n;
    if (min > m.maxPerCharge) out.push({ meterKey: k, code: 'min_exceeds_max_per_charge', detail: `minCharge ${min} > max_per_charge ${m.maxPerCharge} (every charge would abort #24)` });
    if (min > m.rateCap) out.push({ meterKey: k, code: 'min_exceeds_rate_cap', detail: `minCharge ${min} > rate_cap ${m.rateCap}` });
    if (min > budgetLeft) out.push({ meterKey: k, code: 'min_exceeds_budget_left', detail: `minCharge ${min} > remaining budget ${budgetLeft}` });
    const oneUnit = roundDiv(meter.priceNum, meter.priceDen * meter.units, meter.rounding ?? card.rounding ?? 'ceil');
    if (oneUnit > m.maxPerCharge) out.push({ meterKey: k, code: 'unit_exceeds_max_per_charge', detail: `per-unit price ${oneUnit} > max_per_charge ${m.maxPerCharge}` });
  }
  return out;
}

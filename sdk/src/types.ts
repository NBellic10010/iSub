import type { ChargeMode, MandateStatus } from './constants';

/** SDK configuration: the deployed package + the coin type bound to the generic `<T>`. */
export interface IsubConfig {
  /** Published package id (`0x…`). */
  packageId: string;
  /** Fully-qualified coin type for `<T>` (e.g. `0x2::sui::SUI`). */
  coinType: string;
}

/** Parsed on-chain `Account<T>` — the user's reusable, withdraw-anytime balance. */
export interface AccountState {
  id: string;
  owner: string;
  /** Spendable balance in the coin's base units (MIST for SUI). */
  balance: bigint;
}

/** Parsed on-chain `Plan<T>` — a merchant's billing plan. */
export interface PlanState {
  id: string;
  merchant: string;
  mode: ChargeMode;
  /** Fixed: per-period price. PAYG: 0. */
  price: bigint;
  /** Fixed: min ms between charges. PAYG: 0. */
  intervalMs: bigint;
  /** PAYG: max spend per rolling window. Fixed: 0. */
  rateCap: bigint;
  /** PAYG: rolling-window length in ms. Fixed: 0. */
  rateWindowMs: bigint;
  keeper: string;
  active: boolean;
}

/** Parsed on-chain `Mandate<T>` — a capped, revocable pull authorization. Holds no funds. */
export interface MandateState {
  id: string;
  accountId: string;
  subscriber: string;
  merchant: string;
  planId: string;
  mode: ChargeMode;
  // Fixed
  price: bigint;
  intervalMs: bigint;
  lastChargedMs: bigint;
  // PAYG
  rateCap: bigint;
  rateWindowMs: bigint;
  windowStartMs: bigint;
  windowSpent: bigint;
  authorizedKeeper: string;
  // shared caps
  spentTotal: bigint;
  totalBudget: bigint;
  expiryMs: bigint;
  /** On-chain charge counter (+1 per successful charge). Metered charges must pass it back (idempotency); doubles as the reconciliation anchor. */
  chargeSeq: bigint;
  /** Total refunded by the merchant back into the Account. Does NOT restore budget — net spend = spentTotal - refundedTotal. */
  refundedTotal: bigint;
  /** User-set per-charge ceiling (H-1). Fixed: == price. PAYG: the user's independent throttle. Caps slope, not the lifetime ceiling. */
  maxPerCharge: bigint;
  /** Earliest chargeable time (ms). authorize sets `now + firstChargeAfterMs`; charges before it abort. */
  notBeforeMs: bigint;
  status: MandateStatus;
}

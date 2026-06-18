// Mirror of the on-chain constants in `isub::subscription`
// (contracts/sources/subscription.move). Keep in lockstep with the Move module —
// if the Move side changes a code, change it here too.

/** Move module name under the published package. */
export const MODULE = 'subscription';

/**
 * Billing mode (Move: `MODE_FIXED` / `MODE_PAYG`).
 * One Mandate primitive, three billing shapes — Fixed = subscription, PAYG = metered.
 */
export const ChargeMode = { Fixed: 0, Payg: 1 } as const;
export type ChargeMode = (typeof ChargeMode)[keyof typeof ChargeMode];

/** Mandate lifecycle (Move: `STATUS_ACTIVE` / `STATUS_PAUSED` / `STATUS_REVOKED`). Revoked is terminal. */
export const MandateStatus = { Active: 0, Paused: 1, Revoked: 2 } as const;
export type MandateStatus = (typeof MandateStatus)[keyof typeof MandateStatus];

/**
 * Default coin type for the generic `<T>`: SUI on localnet/dev.
 * The primitive is generic — swapping to USDC/USDsui in prod is only a type-argument change.
 */
export const SUI_COIN_TYPE = '0x2::sui::SUI';

/**
 * Move abort codes (Move: `E*` consts). number -> symbolic name.
 * Used to decode aborts in the smoke's negative assertions and in merchant UIs.
 */
export const ERROR_CODES: Readonly<Record<number, string>> = {
  1: 'ENotOwner',
  2: 'ENotSubscriber',
  3: 'ENotAuthorizedCharger',
  4: 'ENotActive',
  5: 'EExpired',
  6: 'EIntervalNotElapsed',
  7: 'EWrongAmount',
  8: 'EOverRateCap',
  9: 'EOverTotalBudget',
  10: 'EInsufficientAccount',
  11: 'EPlanInactive',
  12: 'EBadMode',
  13: 'EAccountMismatch',
  14: 'EZeroPrice',
  15: 'EZeroInterval',
  16: 'EZeroRateCap',
  17: 'EZeroRateWindow',
  18: 'EZeroBudget',
  19: 'EBadExpiry',
  20: 'EBadChargeSeq',
  21: 'ERefundExceedsSpent',
  22: 'ENotMerchant',
  23: 'ETermsMismatch',
  24: 'EOverMaxPerCharge',
  25: 'EZeroMaxPerCharge',
  26: 'ENotPlanMerchant',
  27: 'EWrongVersion',
  28: 'EAccountNotEmpty',
  29: 'EMandateNotRevoked',
};

/** Look up a Move abort code's symbolic name, falling back to `E<code>`. */
export function errorName(code: number): string {
  return ERROR_CODES[code] ?? `E${code}`;
}

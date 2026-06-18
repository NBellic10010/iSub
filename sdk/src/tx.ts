// Pure PTB builders — each adds one Move call to a caller-supplied `Transaction`,
// so they compose into bigger PTBs (e.g. a keeper batching many charges in one tx).
// No execution, no signing, no Node deps → reusable in browser and server alike.

import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import { MODULE } from './constants';
import type { IsubConfig } from './types';

const target = (cfg: IsubConfig, fn: string) => `${cfg.packageId}::${MODULE}::${fn}`;

/** `open_account<T>()` — create + share the caller's reusable Account. */
export function openAccount(tx: Transaction, cfg: IsubConfig): void {
  tx.moveCall({ target: target(cfg, 'open_account'), typeArguments: [cfg.coinType], arguments: [] });
}

/** `deposit<T>(account, coin)` — caller supplies the `Coin<T>` to add (see IsubClient.deposit for SUI auto-split). */
export function deposit(
  tx: Transaction,
  cfg: IsubConfig,
  p: { accountId: string; coin: TransactionObjectArgument },
): void {
  tx.moveCall({
    target: target(cfg, 'deposit'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.accountId), p.coin],
  });
}

/** `withdraw<T>(account, amount)` — owner pulls `amount` back; returned coin is sent to `recipient`. */
export function withdraw(
  tx: Transaction,
  cfg: IsubConfig,
  p: { accountId: string; amount: bigint; recipient: string },
): void {
  const coin = tx.moveCall({
    target: target(cfg, 'withdraw'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.accountId), tx.pure.u64(p.amount)],
  });
  tx.transferObjects([coin], p.recipient);
}

/** `withdraw_all<T>(account)` — owner pulls the full balance back to `recipient`. */
export function withdrawAll(
  tx: Transaction,
  cfg: IsubConfig,
  p: { accountId: string; recipient: string },
): void {
  const coin = tx.moveCall({
    target: target(cfg, 'withdraw_all'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.accountId)],
  });
  tx.transferObjects([coin], p.recipient);
}

/** `create_plan_fixed<T>(price, interval_ms, keeper)` — merchant registers a subscription plan. */
export function createPlanFixed(
  tx: Transaction,
  cfg: IsubConfig,
  p: { price: bigint; intervalMs: bigint; keeper: string },
): void {
  tx.moveCall({
    target: target(cfg, 'create_plan_fixed'),
    typeArguments: [cfg.coinType],
    arguments: [tx.pure.u64(p.price), tx.pure.u64(p.intervalMs), tx.pure.address(p.keeper)],
  });
}

/** `create_plan_payg<T>(rate_cap, rate_window_ms, keeper)` — merchant registers a metered plan. */
export function createPlanPayg(
  tx: Transaction,
  cfg: IsubConfig,
  p: { rateCap: bigint; rateWindowMs: bigint; keeper: string },
): void {
  tx.moveCall({
    target: target(cfg, 'create_plan_payg'),
    typeArguments: [cfg.coinType],
    arguments: [tx.pure.u64(p.rateCap), tx.pure.u64(p.rateWindowMs), tx.pure.address(p.keeper)],
  });
}

/** `deactivate_plan<T>(plan)` — merchant takes a plan off sale (one-way). Blocks new authorizes; existing mandates keep running. */
export function deactivatePlan(tx: Transaction, cfg: IsubConfig, p: { planId: string }): void {
  tx.moveCall({
    target: target(cfg, 'deactivate_plan'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.planId)],
  });
}

/**
 * `authorize_fixed<T>(account, plan, expected_price, expected_interval_ms, total_budget, expiry_ms, first_charge_after_ms, clock)`.
 * The `expected*` are the user's terms echo — the chain asserts they equal the Plan
 * (UI lie / plan-swap ⇒ ETermsMismatch). They MUST come from what the user actually
 * reviewed, never auto-read from the same Plan (see `IsubClient.authorizeFixed`).
 */
export function authorizeFixed(
  tx: Transaction,
  cfg: IsubConfig,
  p: {
    accountId: string;
    planId: string;
    expectedPrice: bigint;
    expectedIntervalMs: bigint;
    expectedMerchant: string;
    totalBudget: bigint;
    expiryMs: bigint;
    firstChargeAfterMs?: bigint;
  },
): void {
  tx.moveCall({
    target: target(cfg, 'authorize_fixed'),
    typeArguments: [cfg.coinType],
    arguments: [
      tx.object(p.accountId),
      tx.object(p.planId),
      tx.pure.u64(p.expectedPrice),
      tx.pure.u64(p.expectedIntervalMs),
      tx.pure.address(p.expectedMerchant),
      tx.pure.u64(p.totalBudget),
      tx.pure.u64(p.expiryMs),
      tx.pure.u64(p.firstChargeAfterMs ?? 0n),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
}

/**
 * `authorize_metered<T>(account, plan, expected_rate_cap, expected_rate_window_ms, total_budget, expiry_ms, max_per_charge, first_charge_after_ms, clock)`.
 * `maxPerCharge` is the user's independent per-charge throttle (must be > 0); it
 * caps the slope, not the ceiling (worst case is still `totalBudget`).
 */
export function authorizeMetered(
  tx: Transaction,
  cfg: IsubConfig,
  p: {
    accountId: string;
    planId: string;
    expectedRateCap: bigint;
    expectedRateWindowMs: bigint;
    expectedMerchant: string;
    expectedKeeper: string;
    totalBudget: bigint;
    expiryMs: bigint;
    maxPerCharge: bigint;
    firstChargeAfterMs?: bigint;
  },
): void {
  tx.moveCall({
    target: target(cfg, 'authorize_metered'),
    typeArguments: [cfg.coinType],
    arguments: [
      tx.object(p.accountId),
      tx.object(p.planId),
      tx.pure.u64(p.expectedRateCap),
      tx.pure.u64(p.expectedRateWindowMs),
      tx.pure.address(p.expectedMerchant),
      tx.pure.address(p.expectedKeeper),
      tx.pure.u64(p.totalBudget),
      tx.pure.u64(p.expiryMs),
      tx.pure.u64(p.maxPerCharge),
      tx.pure.u64(p.firstChargeAfterMs ?? 0n),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
}

/** `charge<T>(account, mandate, amount, clock)` — pull within mandate limits (Fixed: permissionless; PAYG: merchant/keeper). */
export function charge(
  tx: Transaction,
  cfg: IsubConfig,
  p: { accountId: string; mandateId: string; amount: bigint },
): void {
  tx.moveCall({
    target: target(cfg, 'charge'),
    typeArguments: [cfg.coinType],
    arguments: [
      tx.object(p.accountId),
      tx.object(p.mandateId),
      tx.pure.u64(p.amount),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
}

/**
 * `charge_metered<T>(account, mandate, amount, seq, clock)` — PAYG pull (merchant/keeper only).
 * `seq` must equal the mandate's current `charge_seq`: a timed-out retry either lands once or
 * aborts `EBadChargeSeq` — the same bill can never be charged twice.
 */
export function chargeMetered(
  tx: Transaction,
  cfg: IsubConfig,
  p: { accountId: string; mandateId: string; amount: bigint; seq: bigint },
): void {
  tx.moveCall({
    target: target(cfg, 'charge_metered'),
    typeArguments: [cfg.coinType],
    arguments: [
      tx.object(p.accountId),
      tx.object(p.mandateId),
      tx.pure.u64(p.amount),
      tx.pure.u64(p.seq),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
}

/** `refund<T>(account, mandate, coin)` — merchant returns funds into the subscriber's Account. */
export function refund(
  tx: Transaction,
  cfg: IsubConfig,
  p: { accountId: string; mandateId: string; coin: TransactionObjectArgument },
): void {
  tx.moveCall({
    target: target(cfg, 'refund'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.accountId), tx.object(p.mandateId), p.coin],
  });
}

/** `revoke<T>(mandate)` — subscriber cancels; terminal. */
export function revoke(tx: Transaction, cfg: IsubConfig, p: { mandateId: string }): void {
  tx.moveCall({
    target: target(cfg, 'revoke'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.mandateId)],
  });
}

/** `pause<T>(mandate)` — subscriber pauses an active mandate. */
export function pause(tx: Transaction, cfg: IsubConfig, p: { mandateId: string }): void {
  tx.moveCall({
    target: target(cfg, 'pause'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.mandateId)],
  });
}

/** `resume<T>(mandate, clock)` — subscriber resumes; the paused span is forgiven, not deferred. */
export function resume(tx: Transaction, cfg: IsubConfig, p: { mandateId: string }): void {
  tx.moveCall({
    target: target(cfg, 'resume'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.mandateId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
}

// ===== object lifecycle: reclaim storage rebate by deleting the shared object =====

/** `close_account<T>(account)` — owner reclaims an empty Account's storage rebate. */
export function closeAccount(tx: Transaction, cfg: IsubConfig, p: { accountId: string }): void {
  tx.moveCall({
    target: target(cfg, 'close_account'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.accountId)],
  });
}

/** `close_mandate<T>(mandate)` — subscriber reclaims a revoked mandate's storage rebate. */
export function closeMandate(tx: Transaction, cfg: IsubConfig, p: { mandateId: string }): void {
  tx.moveCall({
    target: target(cfg, 'close_mandate'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.mandateId)],
  });
}

/** `close_plan<T>(plan)` — merchant reclaims a plan's storage rebate (existing mandates are unaffected). */
export function closePlan(tx: Transaction, cfg: IsubConfig, p: { planId: string }): void {
  tx.moveCall({
    target: target(cfg, 'close_plan'),
    typeArguments: [cfg.coinType],
    arguments: [tx.object(p.planId)],
  });
}

import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { SUI_COIN_TYPE, MandateStatus, type ChargeMode } from './constants';
import type { IsubConfig, AccountState, PlanState, MandateState } from './types';
import type { IsubSigner, IsubExecResult } from './signer';
import { IsubAbortError, IsubError } from './errors';
import * as build from './tx';

/**
 * High-level iSub client over a gRPC `SuiGrpcClient`: builds a PTB, executes it
 * through an `IsubSigner` (which normalizes the result), and parses ids / typed
 * state. Wraps the client + an `IsubConfig` (package id + coin type for `<T>`).
 *
 * Writes return the tx digest plus any object id created by that call; reads
 * return parsed `*State` objects via `getObject({ json })`. Low-level PTB builders
 * live in `./tx` for callers that compose calls into one transaction.
 */
export class IsubClient {
  readonly client: SuiGrpcClient;
  readonly cfg: IsubConfig;

  constructor(opts: { client: SuiGrpcClient; packageId: string; coinType?: string }) {
    this.client = opts.client;
    this.cfg = { packageId: opts.packageId, coinType: opts.coinType ?? SUI_COIN_TYPE };
  }

  // ===== writes =====

  /** Create the caller's reusable Account. */
  async openAccount(signer: IsubSigner): Promise<{ digest: string; accountId: string }> {
    const res = await this.exec(signer, (tx) => build.openAccount(tx, this.cfg));
    return { digest: res.digest, accountId: this.createdId(res, 'AccountOpened', 'account_id') };
  }

  /** Add `amount` to an Account. SUI-only auto-split from the gas coin; pass coin objects for other `<T>`. */
  async deposit(signer: IsubSigner, p: { accountId: string; amount: bigint }): Promise<{ digest: string }> {
    if (this.cfg.coinType !== SUI_COIN_TYPE) {
      throw new IsubError(
        'config',
        `deposit() auto-splits SUI only; for coinType=${this.cfg.coinType} build the tx with a Coin<T> via tx.deposit()`,
      );
    }
    const res = await this.exec(signer, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [p.amount]);
      build.deposit(tx, this.cfg, { accountId: p.accountId, coin });
    });
    return { digest: res.digest };
  }

  /** Owner pulls `amount` back to their wallet (non-custodial exit). */
  async withdraw(signer: IsubSigner, p: { accountId: string; amount: bigint }): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) =>
      build.withdraw(tx, this.cfg, { accountId: p.accountId, amount: p.amount, recipient: signer.address }),
    );
    return { digest: res.digest };
  }

  /** Owner pulls the entire balance back to their wallet. */
  async withdrawAll(signer: IsubSigner, p: { accountId: string }): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) =>
      build.withdrawAll(tx, this.cfg, { accountId: p.accountId, recipient: signer.address }),
    );
    return { digest: res.digest };
  }

  /** Merchant registers a fixed (subscription) plan. */
  async createPlanFixed(
    signer: IsubSigner,
    p: { price: bigint; intervalMs: bigint; keeper: string },
  ): Promise<{ digest: string; planId: string }> {
    const res = await this.exec(signer, (tx) => build.createPlanFixed(tx, this.cfg, p));
    return { digest: res.digest, planId: this.createdId(res, 'PlanCreated', 'plan_id') };
  }

  /** Merchant registers a PAYG (metered) plan. */
  async createPlanPayg(
    signer: IsubSigner,
    p: { rateCap: bigint; rateWindowMs: bigint; keeper: string },
  ): Promise<{ digest: string; planId: string }> {
    const res = await this.exec(signer, (tx) => build.createPlanPayg(tx, this.cfg, p));
    return { digest: res.digest, planId: this.createdId(res, 'PlanCreated', 'plan_id') };
  }

  /** Merchant takes a plan off sale (one-way). Blocks new authorizes; existing mandates are unaffected. */
  async deactivatePlan(signer: IsubSigner, p: { planId: string }): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) => build.deactivatePlan(tx, this.cfg, p));
    return { digest: res.digest };
  }

  /**
   * Authorize a Fixed (subscription) plan. Signs once, moves no funds.
   *
   * `expectedPrice`/`expectedIntervalMs` are the terms the USER reviewed — the chain
   * aborts (`ETermsMismatch`) if they don't equal the Plan, defeating UI lies / plan
   * swaps. **Do not source them by re-reading the Plan you're authorizing** (that makes
   * the check a tautology); pass what the user was shown (see `quoteFromPlan`, which is
   * display-only). `maxPerCharge` is implicitly `price` for Fixed.
   */
  async authorizeFixed(
    signer: IsubSigner,
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
  ): Promise<{ digest: string; mandateId: string }> {
    const res = await this.exec(signer, (tx) => build.authorizeFixed(tx, this.cfg, p));
    return { digest: res.digest, mandateId: this.createdId(res, 'MandateAuthorized', 'mandate_id') };
  }

  /**
   * Authorize a PAYG (metered) plan. Signs once, moves no funds. Same terms-echo rule
   * as `authorizeFixed`. `maxPerCharge` (> 0) is the user's per-charge throttle —
   * caps the slope, not the lifetime ceiling (still `totalBudget`).
   */
  async authorizeMetered(
    signer: IsubSigner,
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
  ): Promise<{ digest: string; mandateId: string }> {
    const res = await this.exec(signer, (tx) => build.authorizeMetered(tx, this.cfg, p));
    return { digest: res.digest, mandateId: this.createdId(res, 'MandateAuthorized', 'mandate_id') };
  }

  /**
   * Read a Plan's current terms **for display only** — to show the user before they
   * authorize. The values returned here are NOT a safe source for the `expected*`
   * args of authorize (that would make terms-binding a tautology): those must reflect
   * what the user was actually shown on a trusted surface.
   */
  async quoteFromPlan(planId: string): Promise<PlanState> {
    return this.getPlan(planId);
  }

  /** Pull `amount` from the Account within the mandate's limits. */
  async charge(
    signer: IsubSigner,
    p: { accountId: string; mandateId: string; amount: bigint },
  ): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) => build.charge(tx, this.cfg, p));
    return { digest: res.digest };
  }

  /**
   * PAYG metered pull (merchant/keeper only). `seq` must be the mandate's current
   * `chargeSeq` — on a timed-out retry, resubmit the SAME seq: it either lands once
   * or aborts `EBadChargeSeq` (the charge already happened). Never double-bills.
   */
  async chargeMetered(
    signer: IsubSigner,
    p: { accountId: string; mandateId: string; amount: bigint; seq: bigint },
  ): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) => build.chargeMetered(tx, this.cfg, p));
    return { digest: res.digest };
  }

  /** Merchant refunds `amount` back into the subscriber's Account. SUI auto-split; other `<T>` via tx.refund(). */
  async refund(
    signer: IsubSigner,
    p: { accountId: string; mandateId: string; amount: bigint },
  ): Promise<{ digest: string }> {
    if (this.cfg.coinType !== SUI_COIN_TYPE) {
      throw new IsubError(
        'config',
        `refund() auto-splits SUI only; for coinType=${this.cfg.coinType} build the tx with a Coin<T> via tx.refund()`,
      );
    }
    const res = await this.exec(signer, (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [p.amount]);
      build.refund(tx, this.cfg, { accountId: p.accountId, mandateId: p.mandateId, coin: coin! });
    });
    return { digest: res.digest };
  }

  /** Subscriber cancels (terminal). */
  async revoke(signer: IsubSigner, p: { mandateId: string }): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) => build.revoke(tx, this.cfg, p));
    return { digest: res.digest };
  }

  /** Subscriber pauses an active mandate. */
  async pause(signer: IsubSigner, p: { mandateId: string }): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) => build.pause(tx, this.cfg, p));
    return { digest: res.digest };
  }

  /** Subscriber resumes a paused mandate (paused span forgiven). */
  async resume(signer: IsubSigner, p: { mandateId: string }): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) => build.resume(tx, this.cfg, p));
    return { digest: res.digest };
  }

  /** Owner reclaims an empty Account's storage rebate (deletes it; balance must be 0). */
  async closeAccount(signer: IsubSigner, p: { accountId: string }): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) => build.closeAccount(tx, this.cfg, p));
    return { digest: res.digest };
  }

  /** Subscriber reclaims a revoked mandate's storage rebate (deletes it; must be revoked first). */
  async closeMandate(signer: IsubSigner, p: { mandateId: string }): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) => build.closeMandate(tx, this.cfg, p));
    return { digest: res.digest };
  }

  /** Merchant reclaims a plan's storage rebate (deletes it; existing mandates are unaffected). */
  async closePlan(signer: IsubSigner, p: { planId: string }): Promise<{ digest: string }> {
    const res = await this.exec(signer, (tx) => build.closePlan(tx, this.cfg, p));
    return { digest: res.digest };
  }

  // ===== reads =====

  async getAccount(id: string): Promise<AccountState> {
    const f = await this.fields(id);
    return { id, owner: asString(f.owner), balance: asBigInt(f.balance) };
  }

  async getPlan(id: string): Promise<PlanState> {
    const f = await this.fields(id);
    return {
      id,
      merchant: asString(f.merchant),
      mode: asNumber(f.mode) as ChargeMode,
      price: asBigInt(f.price),
      intervalMs: asBigInt(f.interval_ms),
      rateCap: asBigInt(f.rate_cap),
      rateWindowMs: asBigInt(f.rate_window_ms),
      keeper: asString(f.keeper),
      active: asBool(f.active),
    };
  }

  async getMandate(id: string): Promise<MandateState> {
    return parseMandate(id, await this.fields(id));
  }

  /**
   * Read several mandates by id (any status), **all-or-throw**. Used by reconcile /
   * exposure where a missing id is a real error to surface. The keeper uses
   * `getMandatesResolved` instead (fault-isolating).
   *
   * gRPC has no event-query, so mandate *discovery* is the integrator's job: a
   * merchant backend records each `mandate_id` as `authorize` returns it.
   */
  async getMandates(ids: string[]): Promise<MandateState[]> {
    return Promise.all(ids.map((id) => this.getMandate(id)));
  }

  /**
   * Batch-read mandates in a single `getObjects` RPC, **isolating per-object failures**:
   * a deleted / unreadable id comes back as `{ mandate: null }` instead of throwing.
   * This is the keeper's read path — so one bad id can't abort the whole sweep (K-1),
   * and a large watch set isn't N round-trips (K-6). A transport-level failure still
   * rejects the call (the keeper treats that as a transient tick-level error).
   */
  async getMandatesResolved(ids: string[]): Promise<{ id: string; mandate: MandateState | null }[]> {
    if (ids.length === 0) return [];
    const res = await this.client.getObjects({ objectIds: ids, include: { json: true } });
    const byId = new Map<string, Record<string, unknown>>();
    for (const el of res.objects) {
      if (el instanceof Error) continue; // per-object failure (e.g. deleted) — leave absent
      if (typeof el.objectId === 'string' && el.json) {
        byId.set(el.objectId, el.json as Record<string, unknown>);
      }
    }
    return ids.map((id) => {
      const f = byId.get(id);
      return { id, mandate: f ? parseMandate(id, f) : null };
    });
  }

  // ===== internals =====

  private async exec(signer: IsubSigner, fill: (tx: Transaction) => void): Promise<IsubExecResult> {
    const tx = new Transaction();
    tx.setSenderIfNotSet(signer.address);
    fill(tx);
    const res = await signer.signAndExecute({ transaction: tx });
    if (!res.success) throw new IsubAbortError(res.abortCode, res.digest || undefined);
    return res;
  }

  private createdId(res: IsubExecResult, event: string, key: string): string {
    const suffix = `::subscription::${event}`;
    const ev = res.events.find((e) => e.type.endsWith(suffix));
    if (!ev) {
      const seen = res.events.map((e) => e.type).join(', ') || '(none)';
      throw new IsubError('parse', `expected ${event} event in ${res.digest}; saw: ${seen}`);
    }
    const id = ev.json?.[key];
    if (typeof id !== 'string') throw new IsubError('parse', `${event}.${key} is not an id: ${JSON.stringify(id)}`);
    return id;
  }

  private async fields(id: string): Promise<Record<string, unknown>> {
    const res = await this.client.getObject({ objectId: id, include: { json: true } });
    const json = res.object.json;
    if (!json) throw new IsubError('not_found', `object ${id} not found or has no Move struct content`);
    return json;
  }
}

// ===== parsing / coercion helpers (gRPC `json` renders u64 as strings, addresses/ids as 0x…) =====

/** Parse a Mandate object's `json` fields into a `MandateState`. Shared by getMandate / getMandatesResolved. */
function parseMandate(id: string, f: Record<string, unknown>): MandateState {
  return {
    id,
    accountId: asString(f.account_id),
    subscriber: asString(f.subscriber),
    merchant: asString(f.merchant),
    planId: asString(f.plan_id),
    mode: asNumber(f.mode) as ChargeMode,
    price: asBigInt(f.price),
    intervalMs: asBigInt(f.interval_ms),
    lastChargedMs: asBigInt(f.last_charged_ms),
    rateCap: asBigInt(f.rate_cap),
    rateWindowMs: asBigInt(f.rate_window_ms),
    windowStartMs: asBigInt(f.window_start_ms),
    windowSpent: asBigInt(f.window_spent),
    authorizedKeeper: asString(f.authorized_keeper),
    spentTotal: asBigInt(f.spent_total),
    totalBudget: asBigInt(f.total_budget),
    expiryMs: asBigInt(f.expiry_ms),
    chargeSeq: asBigInt(f.charge_seq),
    refundedTotal: asBigInt(f.refunded_total),
    maxPerCharge: asBigInt(f.max_per_charge),
    notBeforeMs: asBigInt(f.not_before_ms),
    status: asNumber(f.status) as MandateStatus,
  };
}

/** Coerce a Move u64/u128 (string | number | `{value}`) into a bigint. */
function asBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  if (v && typeof v === 'object' && 'value' in v) return asBigInt((v as { value: unknown }).value);
  throw new IsubError('parse', `not a u64-ish value: ${JSON.stringify(v)}`);
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  throw new IsubError('parse', `expected string, got: ${JSON.stringify(v)}`);
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  throw new IsubError('parse', `expected number, got: ${JSON.stringify(v)}`);
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  throw new IsubError('parse', `expected boolean, got: ${JSON.stringify(v)}`);
}

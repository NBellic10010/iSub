// H-2 mitigation: total-exposure view for a shared Account.
//
// One Account backs many Mandates and the balance is pulled first-come-first-served,
// so the user's worst case toward an account = the balance, splittable across every
// active mandate within its remaining budget. This surfaces that number so a wallet /
// checkout can show "you're authorizing total X against an account holding Y" BEFORE
// the user signs another authorize — the open-question-#6 UI requirement.
import { MandateStatus } from './constants';
import type { IsubClient } from './client';
import type { MandateState } from './types';

export interface MandateExposure {
  mandateId: string;
  merchant: string;
  /** Still-authorizable pull = totalBudget − spentTotal (the on-chain ceiling, ignoring balance). */
  remaining: bigint;
}

export interface AccountExposure {
  accountId: string;
  /** Current spendable balance. */
  balance: bigint;
  /** Σ remaining authorization across active mandates bound to this account. */
  totalAuthorized: bigint;
  /** Realistic worst-case loss right now = min(balance, totalAuthorized). */
  atRisk: bigint;
  /** True when authorizations exceed the balance (mandates contend; some charges may fail). */
  overAuthorized: boolean;
  byMandate: MandateExposure[];
}

/**
 * Compute an account's exposure across the given mandates (caller supplies the ids it
 * knows — same discovery model as the keeper). Only active mandates actually bound to
 * `accountId` count.
 */
export async function accountExposure(
  isub: IsubClient,
  accountId: string,
  mandateIds: string[],
): Promise<AccountExposure> {
  const [account, mandates] = await Promise.all([
    isub.getAccount(accountId),
    isub.getMandates(mandateIds),
  ]);

  const byMandate: MandateExposure[] = [];
  let totalAuthorized = 0n;
  for (const m of mandates as MandateState[]) {
    if (m.accountId !== accountId || m.status !== MandateStatus.Active) continue;
    const remaining = m.totalBudget > m.spentTotal ? m.totalBudget - m.spentTotal : 0n;
    totalAuthorized += remaining;
    byMandate.push({ mandateId: m.id, merchant: m.merchant, remaining });
  }

  const atRisk = totalAuthorized < account.balance ? totalAuthorized : account.balance;
  return {
    accountId,
    balance: account.balance,
    totalAuthorized,
    atRisk,
    overAuthorized: totalAuthorized > account.balance,
    byMandate,
  };
}

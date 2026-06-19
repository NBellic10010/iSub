// Trusted-display consent (L1b) — make on-chain terms-binding actually meaningful.
//
// `authorize_*` binds `expected_* == Plan` on-chain, but that only protects the user if the
// `expected_*` they authorize come from what they ACTUALLY SAW — not the dApp's HTML, and not
// a silent plan re-read (a tautology). This module derives a CANONICAL consent from the
// on-chain `Plan` (read by a TRUSTED surface — a wallet or a neutral widget, never the dApp's
// DOM): the exact `expected_*` snapshot to authorize with, the human-readable terms to render,
// and a deterministic plain-language INTENT string the user signs (signPersonalMessage).
// Verifying that signature later proves the user consented to EXACTLY these terms.
//
// Pure + isomorphic (only @mysten/sui crypto for verify; no node:*), so the same consent can be
// produced/checked in a wallet, a neutral browser widget, a CLI, or a server.
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { ChargeMode } from './constants';
import { IsubError } from './errors';
import type { PlanState } from './types';

/** What the user chooses (their caps) on top of the merchant's plan terms. */
export interface SubscribeChoice {
  accountId: string;
  /** Lifetime total the user authorizes. */
  totalBudget: bigint;
  /** Subscription expiry (ms epoch). */
  expiryMs: bigint;
  /** PAYG per-charge throttle (defaults to the plan's rate_cap). Fixed: ignored (implicitly == price). */
  maxPerCharge?: bigint;
  /** Earliest-charge delay (defaults 0 = chargeable immediately). */
  firstChargeAfterMs?: bigint;
}

/** Ready to spread into `IsubClient.authorizeFixed`. */
export interface AuthorizeFixedArgs {
  accountId: string;
  planId: string;
  expectedPrice: bigint;
  expectedIntervalMs: bigint;
  expectedMerchant: string;
  totalBudget: bigint;
  expiryMs: bigint;
  firstChargeAfterMs?: bigint;
}
/** Ready to spread into `IsubClient.authorizeMetered`. */
export interface AuthorizeMeteredArgs {
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
}

export interface Consent {
  mode: 'fixed' | 'payg';
  /** Human-readable lines the NEUTRAL surface renders for the user to read before consenting. */
  terms: string[];
  /** Canonical, deterministic statement the user signs via signPersonalMessage (the verifiable record). */
  intentMessage: string;
  /** The exact `expected_*` snapshot to authorize with — derived from the on-chain Plan the user saw. */
  authorize: AuthorizeFixedArgs | AuthorizeMeteredArgs;
}

/** Bump if the message format changes (old signatures stay verifiable against their own version). */
const CONSENT_VERSION = 'isub-consent-v1';

function formatUnits(v: bigint, dec: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(dec);
  const frac = (a % base).toString().padStart(dec, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / base}${frac ? '.' + frac : ''}`;
}
function humanMs(v: bigint): string {
  const n = Number(v);
  if (n === 0) return '0';
  if (n % 86_400_000 === 0) return `${n / 86_400_000}d`;
  if (n % 3_600_000 === 0) return `${n / 3_600_000}h`;
  if (n % 60_000 === 0) return `${n / 60_000}min`;
  if (n % 1_000 === 0) return `${n / 1_000}s`;
  return `${n}ms`;
}

/**
 * The canonical signed record — deterministic, integer-exact (no formatting/locale), and
 * self-describing. `buildConsent` and any verifier build the SAME string from the same
 * (plan, choice), so a signature over it is a faithful, rebuildable record of consent.
 */
export function consentMessage(plan: PlanState, choice: SubscribeChoice): string {
  const isFixed = plan.mode === ChargeMode.Fixed;
  const lines = [
    CONSENT_VERSION,
    `account=${choice.accountId}`,
    `plan=${plan.id}`,
    `merchant=${plan.merchant}`,
    `mode=${isFixed ? 'fixed' : 'payg'}`,
  ];
  if (isFixed) {
    lines.push(`price=${plan.price}`, `interval_ms=${plan.intervalMs}`, `max_per_charge=${plan.price}`);
  } else {
    lines.push(
      `rate_cap=${plan.rateCap}`,
      `rate_window_ms=${plan.rateWindowMs}`,
      `keeper=${plan.keeper}`,
      `max_per_charge=${choice.maxPerCharge ?? plan.rateCap}`,
    );
  }
  lines.push(
    `total_budget=${choice.totalBudget}`,
    `expiry_ms=${choice.expiryMs}`,
    `first_charge_after_ms=${choice.firstChargeAfterMs ?? 0n}`,
    `I authorize charges within EXACTLY these limits. Revocable anytime; funds withdrawable anytime (non-custodial).`,
  );
  return lines.join('\n');
}

/**
 * Build a consent from the on-chain `Plan` (read by a trusted surface) + the user's `choice`.
 * Returns the human terms to render, the intent string to sign, and the exact `expected_*` to
 * authorize with — all derived from the SAME plan read, so the rendered terms, the signed
 * statement, and the on-chain authorization cannot disagree.
 */
export function buildConsent(plan: PlanState, choice: SubscribeChoice, opts: { coinSymbol?: string; decimals?: number } = {}): Consent {
  if (choice.totalBudget <= 0n) throw new IsubError('usage', 'totalBudget must be positive');
  if (!plan.active) throw new IsubError('config', 'plan is not active (cannot consent to an inactive plan)');
  const sym = opts.coinSymbol ?? 'SUI';
  const dec = opts.decimals ?? 9;
  const fmt = (v: bigint): string => `${formatUnits(v, dec)} ${sym}`;
  const firstAfter = choice.firstChargeAfterMs ?? 0n;
  const expiryHuman = new Date(Number(choice.expiryMs)).toISOString();
  const tail = [
    `Total you authorize (lifetime cap): ${fmt(choice.totalBudget)}`,
    `Expires: ${expiryHuman}`,
    ...(firstAfter > 0n ? [`First charge no earlier than: +${humanMs(firstAfter)}`] : []),
    `You can revoke anytime and withdraw your funds anytime (non-custodial).`,
  ];
  const intentMessage = consentMessage(plan, choice);

  if (plan.mode === ChargeMode.Fixed) {
    const authorize: AuthorizeFixedArgs = {
      accountId: choice.accountId,
      planId: plan.id,
      expectedPrice: plan.price,
      expectedIntervalMs: plan.intervalMs,
      expectedMerchant: plan.merchant,
      totalBudget: choice.totalBudget,
      expiryMs: choice.expiryMs,
      firstChargeAfterMs: firstAfter,
    };
    const terms = [
      `Subscription (Fixed) — recurring pull payments.`,
      `Merchant (payee): ${plan.merchant}`,
      `Plan: ${plan.id}`,
      `Price: ${fmt(plan.price)} every ${humanMs(plan.intervalMs)}`,
      `Per-charge maximum: ${fmt(plan.price)}`,
      ...tail,
    ];
    return { mode: 'fixed', terms, intentMessage, authorize };
  }

  const maxPerCharge = choice.maxPerCharge ?? plan.rateCap;
  const authorize: AuthorizeMeteredArgs = {
    accountId: choice.accountId,
    planId: plan.id,
    expectedRateCap: plan.rateCap,
    expectedRateWindowMs: plan.rateWindowMs,
    expectedMerchant: plan.merchant,
    expectedKeeper: plan.keeper,
    totalBudget: choice.totalBudget,
    expiryMs: choice.expiryMs,
    maxPerCharge,
    firstChargeAfterMs: firstAfter,
  };
  const terms = [
    `Metered (PAYG) — usage-based pull payments.`,
    `Merchant (payee): ${plan.merchant}`,
    `Authorized charger (keeper): ${plan.keeper}`,
    `Plan: ${plan.id}`,
    `Rate cap: up to ${fmt(plan.rateCap)} per ${humanMs(plan.rateWindowMs)}`,
    `Per-charge maximum: ${fmt(maxPerCharge)}`,
    ...tail,
  ];
  return { mode: 'payg', terms, intentMessage, authorize };
}

/**
 * Verify that `address` signed `intentMessage` (the consent record). The message is
 * self-describing, so an auditor reads it to see the exact terms consented to, and this proves
 * the address actually signed them. Returns false on any invalid/mismatched signature.
 */
export async function verifyConsentSignature(intentMessage: string, signature: string, address: string): Promise<boolean> {
  try {
    const pk = await verifyPersonalMessageSignature(new TextEncoder().encode(intentMessage), signature);
    return pk.toSuiAddress() === address;
  } catch {
    return false;
  }
}

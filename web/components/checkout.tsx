'use client';
import { useCallback, useEffect, useState } from 'react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { ChargeMode, errorName, abortCodeOf, type PlanState } from '@isub/sdk';
import { useIsub } from '@/lib/use-isub';
import { fmtSui, toMist, shortId, DAY_MS } from '@/lib/format';
import { Button, Badge, AddressChip } from '@/components/ui';
import { Logo } from '@/components/logo';
import { webGateway } from '@/lib/gateway';

// Opts the embedding merchant passes (via URL query). The merchant supplies only the planId +
// budget; the REAL terms are read from chain here and shown to the user — the merchant cannot
// restyle or fake this surface (it runs on iSub's origin, isolated in an iframe).
interface CheckoutParams {
  planId: string;
  budget: string; // SUI decimal
  origin: string; // where to postMessage the result (the loader's origin)
  ttlDays: number;
  maxPerCharge?: string; // SUI decimal (PAYG only; defaults to rate cap)
  consent: boolean; // if set, also capture a plain-language signed consent (signPersonalMessage)
}

function readParams(): CheckoutParams | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  const planId = q.get('planId');
  const budget = q.get('budget');
  if (!planId || !budget) return null;
  return {
    planId,
    budget,
    origin: q.get('origin') ?? '*',
    ttlDays: Number(q.get('ttlDays') ?? '30'),
    maxPerCharge: q.get('maxPerCharge') ?? undefined,
    consent: q.get('consent') === '1',
  };
}

function post(origin: string, msg: Record<string, unknown>): void {
  try {
    window.parent?.postMessage({ source: 'isub-checkout', ...msg }, origin || '*');
  } catch {
    /* standalone (not embedded) — ignore */
  }
}

const gw = webGateway();

export default function Checkout() {
  const { isub, signer, signMessage, address, connected, network } = useIsub();
  const [params, setParams] = useState<CheckoutParams | null>(null);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [done, setDone] = useState<{ mandateId: string; accountId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setParams(readParams()), []);

  // The neutral display: read the plan's REAL terms from chain (not from the merchant).
  useEffect(() => {
    if (!params) return;
    isub.quoteFromPlan(params.planId).then(setPlan).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [isub, params]);

  // Reuse an account this wallet opened before (remembered on iSub's origin), else open inline.
  useEffect(() => {
    if (!address) return setAccountId(null);
    setAccountId(localStorage.getItem(`isub:${network}:${address}:account`));
  }, [address, network]);

  const fail = useCallback((reason: string) => {
    setError(reason);
    setBusy(null);
  }, []);

  async function ensureAccount(): Promise<string> {
    if (accountId) return accountId;
    setBusy('Opening your account…');
    const { accountId: id } = await isub.openAccount(signer!);
    localStorage.setItem(`isub:${network}:${address}:account`, id);
    setAccountId(id);
    return id;
  }

  async function subscribe(): Promise<void> {
    if (!params || !plan || !signer) return;
    setError(null);
    try {
      const acct = await ensureAccount();
      const budget = toMist(params.budget);
      const expiryMs = BigInt(Date.now() + params.ttlDays * DAY_MS);

      // Optional L1b: capture an explicit, human-readable signed consent before the on-chain authorize.
      if (params.consent && signMessage) {
        setBusy('Sign the consent…');
        await signMessage(consentText(plan, params, budget));
      }

      setBusy('Authorize in your wallet…');
      let mandateId: string;
      if (plan.mode === ChargeMode.Fixed) {
        ({ mandateId } = await isub.authorizeFixed(signer, {
          accountId: acct,
          planId: params.planId,
          expectedPrice: plan.price,
          expectedIntervalMs: plan.intervalMs,
          expectedMerchant: plan.merchant,
          totalBudget: budget,
          expiryMs,
        }));
      } else {
        ({ mandateId } = await isub.authorizeMetered(signer, {
          accountId: acct,
          planId: params.planId,
          expectedRateCap: plan.rateCap,
          expectedRateWindowMs: plan.rateWindowMs,
          expectedMerchant: plan.merchant,
          expectedKeeper: plan.keeper,
          totalBudget: budget,
          expiryMs,
          maxPerCharge: params.maxPerCharge ? toMist(params.maxPerCharge) : plan.rateCap,
        }));
      }
      try { await gw.ingestMandate(mandateId); } catch { /* gateway down — subscriber can still track it manually */ }
      setBusy(null);
      setDone({ mandateId, accountId: acct });
      post(params.origin, { type: 'isub:result', ok: true, mandateId, accountId: acct });
    } catch (e) {
      const code = abortCodeOf(e);
      fail(code != null ? `${errorName(code)} (#${code})` : e instanceof Error ? e.message : String(e));
    }
  }

  function cancel(): void {
    post(params?.origin ?? '*', { type: 'isub:cancel', ok: false });
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ width: '100%', maxWidth: 380 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Logo size={15} /><span className="muted" style={{ fontSize: 12 }}>authorize</span></span>
          <span className="muted" style={{ fontSize: 11 }}>{network}</span>
        </div>

        {!params && <p style={{ color: 'var(--danger)', fontSize: 13 }}>Missing planId/budget.</p>}

        {params && !plan && !error && <p className="muted" style={{ fontSize: 14 }}>Loading terms from chain…</p>}

        {plan && params && !done && (
          <>
            <p style={{ fontSize: 16, fontWeight: 500, margin: '0 0 12px' }}>{shortId(plan.id)}</p>
            <Terms plan={plan} budget={params.budget} />
            <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--success)', margin: '12px 0 14px' }}>
              <span style={{ fontWeight: 500 }}>✓</span> Funds stay in your wallet · cancel anytime
            </p>

            {!connected ? (
              <ConnectButton />
            ) : (
              <div className="row" style={{ gap: 8 }}>
                <Button onClick={() => void subscribe()} disabled={!!busy} variant="primary">
                  {busy ?? 'Review & sign in wallet'}
                </Button>
                <Button onClick={cancel} disabled={!!busy}>Cancel</Button>
              </div>
            )}
            {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>✗ {error}</p>}
          </>
        )}

        {done && (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <Badge kind="success">Subscribed</Badge>
            <p className="mono" style={{ fontSize: 12, color: 'var(--muted)', margin: '12px 0 4px' }}>{shortId(done.mandateId)}</p>
            <p className="muted" style={{ fontSize: 13 }}>You can cancel anytime from your iSub account.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Terms({ plan, budget }: { plan: PlanState; budget: string }) {
  const rows: [string, React.ReactNode][] =
    plan.mode === ChargeMode.Fixed
      ? [
          ['price', <span className="mono" key="p">{fmtSui(plan.price)} SUI / {Number(plan.intervalMs) / 1000}s</span>],
        ]
      : [
          ['rate cap', <span className="mono" key="r">{fmtSui(plan.rateCap)} SUI / {Number(plan.rateWindowMs) / 1000}s window</span>],
        ];
  rows.push(['to merchant', <AddressChip id={plan.merchant} key="m" />]);
  rows.push(['budget cap', <span className="mono" key="b">{budget} SUI</span>]);
  return (
    <div>
      {rows.map(([k, v], i) => (
        <div key={i} className="row" style={{ justifyContent: 'space-between', fontSize: 13, padding: '5px 0', borderTop: i === 0 ? '0.5px solid var(--border)' : undefined }}>
          <span className="muted">{k}</span>
          {v}
        </div>
      ))}
    </div>
  );
}

function consentText(plan: PlanState, p: CheckoutParams, budget: bigint): string {
  const terms =
    plan.mode === ChargeMode.Fixed
      ? `${fmtSui(plan.price)} SUI every ${Number(plan.intervalMs) / 1000}s`
      : `up to ${fmtSui(plan.rateCap)} SUI per ${Number(plan.rateWindowMs) / 1000}s window`;
  return [
    `I authorize iSub to charge ${terms}`,
    `to merchant ${plan.merchant}`,
    `up to a total of ${fmtSui(budget)} SUI, for ${p.ttlDays} days.`,
    `Funds stay in my wallet; I can cancel anytime.`,
  ].join('\n');
}

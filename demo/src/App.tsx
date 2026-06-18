import { useCallback, useEffect, useState } from 'react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { MandateStatus, errorName, abortCodeOf } from '@isub/sdk';
import type { MandateState, PlanState } from '@isub/sdk';
import { useIsub } from './isub';

const MIST = 1_000_000_000n;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEMO_PRICE = MIST / 100n; // 0.01 SUI / period
const DEMO_INTERVAL_MS = 60_000n; // 60s, so a 2nd charge inside the minute shows the interval guard

type Sub = { id: string; mandate: MandateState | null };

// ===== small helpers =====
function toMist(sui: string): bigint {
  const t = sui.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`enter a positive SUI amount (got "${sui}")`);
  const [whole, frac = ''] = t.split('.');
  return BigInt(whole) * MIST + BigInt((frac + '000000000').slice(0, 9) || '0');
}
function fmtSui(mist: bigint): string {
  const neg = mist < 0n;
  const m = neg ? -mist : mist;
  const frac = (m % MIST).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${m / MIST}${frac ? '.' + frac : ''} SUI`;
}
const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;
function statusLabel(s: MandateStatus): string {
  return s === MandateStatus.Active ? 'Active' : s === MandateStatus.Paused ? 'Paused' : 'Revoked';
}

// ===== styles =====
const s = {
  page: { maxWidth: 760, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#1a1a2e' } as const,
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 } as const,
  card: { border: '1px solid #e1e1ee', borderRadius: 12, padding: 16, marginBottom: 14, background: '#fff' } as const,
  h2: { margin: '0 0 10px', fontSize: 15, fontWeight: 700 } as const,
  btn: { padding: '7px 13px', borderRadius: 8, border: '1px solid #4338ca', background: '#4338ca', color: '#fff', cursor: 'pointer', fontSize: 13, marginRight: 8 } as const,
  btnGhost: { padding: '6px 11px', borderRadius: 8, border: '1px solid #c7c7d9', background: '#fff', color: '#333', cursor: 'pointer', fontSize: 13, marginRight: 8 } as const,
  input: { padding: '6px 9px', borderRadius: 7, border: '1px solid #c7c7d9', fontSize: 13, width: 130, marginRight: 8 } as const,
  inputWide: { padding: '6px 9px', borderRadius: 7, border: '1px solid #c7c7d9', fontSize: 13, width: 380, marginRight: 8, fontFamily: 'monospace' } as const,
  mono: { fontFamily: 'monospace', fontSize: 12 } as const,
  err: { color: '#b91c1c', fontSize: 13, marginTop: 8 } as const,
  info: { color: '#047857', fontSize: 13, marginTop: 8 } as const,
  muted: { color: '#6b7280', fontSize: 12 } as const,
};

export function App() {
  const { isub, signer, address, connected, network } = useIsub();
  const ns = `isub:${network}:${address ?? '-'}`;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [planId, setPlanId] = useState('');
  const [quote, setQuote] = useState<PlanState | null>(null);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [depositSui, setDepositSui] = useState('0.1');
  const [budgetSui, setBudgetSui] = useState('0.05');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refreshAccount = useCallback(
    async (id: string) => {
      try {
        setBalance((await isub.getAccount(id)).balance);
      } catch {
        setBalance(null); // closed / not found
      }
    },
    [isub],
  );
  const refreshSubs = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return setSubs([]);
      setSubs(await isub.getMandatesResolved(ids));
    },
    [isub],
  );

  // On connect (or address/network change), restore what this app recorded for the user.
  // gRPC has no "objects by owner" query for our types, so the app records ids as the SDK
  // returns them (here: localStorage) — exactly the integrator responsibility the SDK documents.
  useEffect(() => {
    setError(null);
    setInfo(null);
    if (!address) {
      setAccountId(null);
      setBalance(null);
      setSubs([]);
      return;
    }
    const acc = localStorage.getItem(`${ns}:account`);
    const ids = JSON.parse(localStorage.getItem(`${ns}:mandates`) ?? '[]') as string[];
    setAccountId(acc);
    if (acc) void refreshAccount(acc);
    void refreshSubs(ids);
  }, [address, ns, refreshAccount, refreshSubs]);

  async function run(label: string, fn: () => Promise<string | void>): Promise<void> {
    setBusy(label);
    setError(null);
    setInfo(null);
    try {
      const msg = await fn();
      if (msg) setInfo(msg);
    } catch (e) {
      const code = abortCodeOf(e);
      setError(code != null ? `${errorName(code)} (#${code})` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function rememberMandate(id: string) {
    const ids = JSON.parse(localStorage.getItem(`${ns}:mandates`) ?? '[]') as string[];
    if (!ids.includes(id)) localStorage.setItem(`${ns}:mandates`, JSON.stringify([...ids, id]));
  }

  // ===== actions (every write goes through the connected wallet) =====
  const doOpen = () =>
    run('Opening account…', async () => {
      const { accountId: id } = await isub.openAccount(signer!);
      localStorage.setItem(`${ns}:account`, id);
      setAccountId(id);
      await refreshAccount(id);
      return `Account opened — ${short(id)}`;
    });

  const doDeposit = () =>
    run('Depositing…', async () => {
      const amount = toMist(depositSui);
      await isub.deposit(signer!, { accountId: accountId!, amount });
      await refreshAccount(accountId!);
      return `Deposited ${fmtSui(amount)}`;
    });

  const doWithdrawAll = () =>
    run('Withdrawing…', async () => {
      await isub.withdrawAll(signer!, { accountId: accountId! });
      await refreshAccount(accountId!);
      return 'Withdrew full balance back to your wallet';
    });

  const doCreatePlan = () =>
    run('Publishing demo plan…', async () => {
      // For the demo, you act as the merchant: publish a Fixed plan, then subscribe to it.
      const { planId: id } = await isub.createPlanFixed(signer!, {
        price: DEMO_PRICE,
        intervalMs: DEMO_INTERVAL_MS,
        keeper: address!,
      });
      setPlanId(id);
      setQuote(await isub.quoteFromPlan(id));
      return `Plan published — ${short(id)} (${fmtSui(DEMO_PRICE)} / 60s)`;
    });

  const doLoadQuote = () =>
    run('Loading plan terms…', async () => {
      const q = await isub.quoteFromPlan(planId.trim());
      setQuote(q);
      return `Terms: ${fmtSui(q.price)} every ${Number(q.intervalMs) / 1000}s · merchant ${short(q.merchant)}`;
    });

  const doSubscribe = () =>
    run('Authorizing subscription…', async () => {
      if (!quote) throw new Error('load the plan terms first');
      const { mandateId } = await isub.authorizeFixed(signer!, {
        accountId: accountId!,
        planId: planId.trim(),
        // Terms-binding: echo what the user was shown. In production these MUST come from a
        // trusted display surface — here we bind to the quote we just rendered (demo simplification).
        expectedPrice: quote.price,
        expectedIntervalMs: quote.intervalMs,
        expectedMerchant: quote.merchant,
        totalBudget: toMist(budgetSui),
        expiryMs: BigInt(Date.now() + 30 * DAY_MS),
      });
      rememberMandate(mandateId);
      await refreshSubs([...subs.map((r) => r.id), mandateId]);
      return `Subscribed — mandate ${short(mandateId)} (no funds moved; charges pull within budget)`;
    });

  const doCharge = (row: Sub) =>
    run('Pulling one period…', async () => {
      // Fixed charge is permissionless — in prod the merchant/keeper calls this on schedule.
      await isub.charge(signer!, { accountId: accountId!, mandateId: row.id, amount: row.mandate!.price });
      await Promise.all([refreshAccount(accountId!), refreshSubs(subs.map((r) => r.id))]);
      return `Charged ${fmtSui(row.mandate!.price)} for ${short(row.id)}`;
    });

  const doUnsub = (row: Sub) =>
    run('Cancelling…', async () => {
      await isub.revoke(signer!, { mandateId: row.id });
      await refreshSubs(subs.map((r) => r.id));
      return `Unsubscribed — ${short(row.id)} is now revoked (no future charges)`;
    });

  // ===== render =====
  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>iSub</h1>
          <div style={s.muted}>non-custodial subscriptions on Sui · {network}</div>
        </div>
        <ConnectButton />
      </div>

      {!connected ? (
        <div style={s.card}>
          <h2 style={s.h2}>Connect your wallet to sign in</h2>
          <p style={{ fontSize: 14, lineHeight: 1.5 }}>
            There's no password and no account on our servers — <b>your wallet is your identity</b>. Connect a Sui{' '}
            <b>{network}</b> wallet (funded with a little gas) to open an Account, subscribe to a plan, and cancel —
            all non-custodially.
          </p>
          <ConnectButton />
        </div>
      ) : (
        <>
          {/* 1 — Account */}
          <div style={s.card}>
            <h2 style={s.h2}>① Your Account</h2>
            {accountId ? (
              <>
                <div style={s.mono}>id: {accountId}</div>
                <div style={{ margin: '6px 0 10px' }}>
                  balance: <b>{balance == null ? '—' : fmtSui(balance)}</b>
                </div>
                <input style={s.input} value={depositSui} onChange={(e) => setDepositSui(e.target.value)} /> SUI
                <button style={s.btn} disabled={!!busy} onClick={doDeposit}>
                  Deposit
                </button>
                <button style={s.btnGhost} disabled={!!busy} onClick={doWithdrawAll}>
                  Withdraw all
                </button>
              </>
            ) : (
              <>
                <p style={{ fontSize: 14, margin: '0 0 10px' }}>
                  Open a reusable balance you control. You can withdraw anytime — no pre-funding lock-in.
                </p>
                <button style={s.btn} disabled={!!busy} onClick={doOpen}>
                  Open account
                </button>
              </>
            )}
          </div>

          {/* 2 — Plan */}
          {accountId && (
            <div style={s.card}>
              <h2 style={s.h2}>② A plan to subscribe to</h2>
              <input
                style={s.inputWide}
                placeholder="plan id (0x…)"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              />
              <button style={s.btnGhost} disabled={!!busy || !planId.trim()} onClick={doLoadQuote}>
                Load terms
              </button>
              <div style={{ marginTop: 10 }}>
                <span style={s.muted}>No plan handy? Publish a demo one (you act as the merchant): </span>
                <button style={s.btnGhost} disabled={!!busy} onClick={doCreatePlan}>
                  Create demo plan
                </button>
              </div>
              {quote && (
                <div style={{ marginTop: 10, fontSize: 13 }}>
                  <b>{fmtSui(quote.price)}</b> every {Number(quote.intervalMs) / 1000}s · merchant{' '}
                  <span style={s.mono}>{short(quote.merchant)}</span> · {quote.active ? 'on sale' : 'inactive'}
                </div>
              )}
            </div>
          )}

          {/* 3 — Subscribe */}
          {accountId && quote && (
            <div style={s.card}>
              <h2 style={s.h2}>③ Subscribe (authorize a capped mandate)</h2>
              <p style={{ margin: '0 0 10px', ...s.muted }}>
                Authorizing signs once and moves <b>no funds</b>. Charges pull from your Account up to the budget; you
                can cancel anytime.
              </p>
              budget <input style={s.input} value={budgetSui} onChange={(e) => setBudgetSui(e.target.value)} /> SUI
              <button style={s.btn} disabled={!!busy} onClick={doSubscribe}>
                Subscribe
              </button>
            </div>
          )}

          {/* 4 — Subscriptions */}
          {subs.length > 0 && (
            <div style={s.card}>
              <h2 style={s.h2}>④ Your subscriptions</h2>
              {subs.map((row) => (
                <div key={row.id} style={{ borderTop: '1px solid #eee', padding: '10px 0' }}>
                  <div style={s.mono}>{row.id}</div>
                  {row.mandate ? (
                    <div style={{ fontSize: 13, margin: '4px 0 8px' }}>
                      <b>{statusLabel(row.mandate.status)}</b> · spent {fmtSui(row.mandate.spentTotal)} /{' '}
                      {fmtSui(row.mandate.totalBudget)} · {fmtSui(row.mandate.price)} per period
                    </div>
                  ) : (
                    <div style={{ ...s.muted, margin: '4px 0 8px' }}>closed / not found</div>
                  )}
                  {row.mandate?.status === MandateStatus.Active && (
                    <>
                      <button style={s.btnGhost} disabled={!!busy} onClick={() => doCharge(row)}>
                        Charge 1 period (merchant pull)
                      </button>
                      <button style={s.btnGhost} disabled={!!busy} onClick={() => doUnsub(row)}>
                        Unsubscribe
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {busy && <div style={s.muted}>{busy}</div>}
      {error && <div style={s.err}>✗ {error}</div>}
      {info && <div style={s.info}>✓ {info}</div>}
    </div>
  );
}

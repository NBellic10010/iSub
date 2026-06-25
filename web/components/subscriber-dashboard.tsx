'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { MandateStatus, ChargeMode, errorName, abortCodeOf, accountExposure, type MandateState, type PlanState } from '@isubpay/sdk';
import { useIsub } from '@/lib/use-isub';
import { fmtSui, toMist, shortId, DAY_MS } from '@/lib/format';
import { Card, Metric, Badge, Button, AddressChip } from '@/components/ui';
import { Logo } from '@/components/logo';
import { webGateway } from '@/lib/gateway';
import { UsageChart } from '@/components/usage-chart';
import { WalletUsageTable } from '@/components/wallet-usage-table';
import { X402AgentExport } from '@/components/x402-agent-export';
import { ExportReportButton } from '@/components/compliance-report';

type Sub = { id: string; mandate: MandateState | null };
type Exposure = Awaited<ReturnType<typeof accountExposure>>;
const gw = webGateway();

function statusBadge(s: MandateStatus) {
  if (s === MandateStatus.Active) return <Badge kind="accent">Active</Badge>;
  if (s === MandateStatus.Paused) return <Badge kind="warning">Paused</Badge>;
  return <Badge kind="neutral">Revoked</Badge>;
}

export default function SubscriberDashboard() {
  const { isub, signer, signMessage, address, connected, network } = useIsub();
  const ns = `isub:${network}:${address ?? '-'}`;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [exposure, setExposure] = useState<Exposure | null>(null);
  const [depositSui, setDepositSui] = useState('0.1');
  const [trackId, setTrackId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [chartFor, setChartFor] = useState<string | null>(null);
  // Active subscribe-to-a-plan flow
  const [planIdInput, setPlanIdInput] = useState('');
  const [quotedPlan, setQuotedPlan] = useState<PlanState | null>(null);
  const [subBudget, setSubBudget] = useState('0.2');
  const [subMaxPerCharge, setSubMaxPerCharge] = useState('');
  const [subTtlDays, setSubTtlDays] = useState('30');

  const refreshAccount = useCallback(
    async (id: string) => {
      try {
        setBalance((await isub.getAccount(id)).balance);
      } catch {
        setBalance(null);
      }
    },
    [isub],
  );

  // The connected wallet's OWN native SUI (gas + what's available to deposit) — distinct from the
  // iSub Account balance. Same call the SDK's `suiBalance` helper uses.
  const refreshWallet = useCallback(async () => {
    if (!address) return setWalletBalance(null);
    try {
      setWalletBalance(BigInt((await isub.client.getBalance({ owner: address })).balance.balance));
    } catch {
      setWalletBalance(null);
    }
  }, [isub, address]);

  const refreshSubs = useCallback(
    async (id: string | null, ids: string[]) => {
      let rows: Sub[] = [];
      if (ids.length) {
        try {
          rows = await isub.getMandatesResolved(ids);
        } catch {
          // Batched getObjects can fail at the gRPC-web transport layer in some browsers; fall back to
          // per-id singular reads (the proven path — the same getObject getAccount uses), isolating
          // failures so one unreadable id (e.g. wrong network) shows as `unreadable`, not a blank list.
          rows = await Promise.all(
            ids.map(async (mid): Promise<Sub> => {
              try {
                return { id: mid, mandate: await isub.getMandate(mid) };
              } catch {
                return { id: mid, mandate: null };
              }
            }),
          );
        }
      }
      setSubs(rows);
      if (id) {
        try {
          setExposure(await accountExposure(isub, id, ids));
        } catch {
          setExposure(null);
        }
      }
    },
    [isub],
  );

  // Discover the user's account + mandates cross-device from the gateway index (by wallet address),
  // merged with locally-remembered ids. Gateway down → localStorage only (still works on this device).
  const load = useCallback(async () => {
    if (!address) {
      setAccountId(null);
      setBalance(null);
      setWalletBalance(null);
      setSubs([]);
      setExposure(null);
      return;
    }
    let acc = localStorage.getItem(`${ns}:account`);
    const ids = new Set(JSON.parse(localStorage.getItem(`${ns}:mandates`) ?? '[]') as string[]);
    try {
      // discoverMandatesBySubscriber (not the plain read) so we list the wallet's COMPLETE set —
      // it reconciles against chain (scans MandateAuthorized events + ingests any the index missed),
      // recovering subscriptions made on another device / outside iSub's surfaces. The 5s poll below
      // stays on the cheap cached read; this fuller scan runs only here, on connect/load.
      const [accs, mans] = await Promise.all([gw.accountsByOwner(address), gw.discoverMandatesBySubscriber(address)]);
      // Only ADOPT a gateway-discovered account the chain can actually confirm — skip rows the chain
      // can't read (mock / deleted / not-yet-finalized), so an unreadable index row never breaks the
      // balance or leaves deposit/withdraw pointing at a non-existent account.
      if (!acc) {
        for (const a of accs) {
          try {
            await isub.getAccount(a.accountId);
            acc = a.accountId;
            break;
          } catch {
            /* not a live account — skip */
          }
        }
      }
      for (const m of mans) ids.add(m.mandateId);
      if (acc) localStorage.setItem(`${ns}:account`, acc);
    } catch {
      /* gateway unavailable → fall back to locally-remembered ids */
    }
    // Drop ids the user cleared (unreadable: deleted / wrong network / stale) so gateway
    // re-discovery doesn't resurrect them. Re-tracking an id un-dismisses it (see doTrack).
    for (const d of JSON.parse(localStorage.getItem(`${ns}:dismissed`) ?? '[]') as string[]) ids.delete(d);
    localStorage.setItem(`${ns}:mandates`, JSON.stringify([...ids]));
    setAccountId(acc);
    void refreshWallet();
    if (acc) void refreshAccount(acc);
    void refreshSubs(acc, [...ids]);
  }, [address, ns, isub, refreshAccount, refreshSubs, refreshWallet]);

  useEffect(() => {
    setError(null);
    setInfo(null);
    void load();
  }, [load]);

  // Live poll (~5s): re-read on-chain mandate state so keeper charges (FIXED interval / PAYG) make
  // spentTotal tick up on screen without a manual reload — essential for the recurring-charge demo.
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => {
      const ids = JSON.parse(localStorage.getItem(`${ns}:mandates`) ?? '[]') as string[];
      void refreshSubs(accountId, ids);
    }, 5000);
    return () => clearInterval(t);
  }, [connected, accountId, ns, refreshSubs]);

  function mandateIds(): string[] {
    return JSON.parse(localStorage.getItem(`${ns}:mandates`) ?? '[]') as string[];
  }

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

  const doOpen = () =>
    run('Opening account…', async () => {
      const { accountId: id } = await isub.openAccount(signer!);
      localStorage.setItem(`${ns}:account`, id);
      setAccountId(id);
      try { await gw.ingestAccount(id); } catch { /* gateway down — discoverable later */ }
      await refreshAccount(id);
      await refreshWallet();
      return `Account opened — ${shortId(id)}`;
    });

  const doDeposit = () =>
    run('Depositing…', async () => {
      const amount = toMist(depositSui);
      await isub.deposit(signer!, { accountId: accountId!, amount });
      await refreshAccount(accountId!);
      await refreshWallet();
      return `Deposited ${fmtSui(amount)} SUI`;
    });

  const doWithdrawAll = () =>
    run('Withdrawing…', async () => {
      await isub.withdrawAll(signer!, { accountId: accountId! });
      await refreshAccount(accountId!);
      await refreshWallet();
      return 'Withdrew full balance back to your wallet';
    });

  const doTrack = () =>
    run('Tracking subscription…', async () => {
      const id = trackId.trim();
      if (!id) return;
      const undismissed = (JSON.parse(localStorage.getItem(`${ns}:dismissed`) ?? '[]') as string[]).filter((d) => d !== id);
      localStorage.setItem(`${ns}:dismissed`, JSON.stringify(undismissed));
      const ids = [...new Set([...mandateIds(), id])];
      localStorage.setItem(`${ns}:mandates`, JSON.stringify(ids));
      setTrackId('');
      try { await gw.ingestMandate(id); } catch { /* gateway down — local only */ }
      await refreshSubs(accountId, ids);
      return `Now watching ${shortId(id)}`;
    });

  // Remove the rows the chain can't read (deleted / wrong network / stale). They're added to a
  // dismissed set so load()'s gateway re-discovery won't bring them back; re-track to undo.
  const doClearUnreadable = () =>
    run('Clearing…', async () => {
      const dead = subs.filter((s) => !s.mandate).map((s) => s.id);
      if (dead.length === 0) return;
      const dismissed = new Set(JSON.parse(localStorage.getItem(`${ns}:dismissed`) ?? '[]') as string[]);
      dead.forEach((d) => dismissed.add(d));
      localStorage.setItem(`${ns}:dismissed`, JSON.stringify([...dismissed]));
      localStorage.setItem(`${ns}:mandates`, JSON.stringify(mandateIds().filter((id) => !dismissed.has(id))));
      setSubs((prev) => prev.filter((s) => s.mandate));
      if (chartFor && dead.includes(chartFor)) setChartFor(null);
      return `Cleared ${dead.length} unreadable record${dead.length > 1 ? 's' : ''}`;
    });

  // Hide cancelled (revoked) subscriptions — readable but terminal. Same dismissed-set trick so load()'s
  // chain re-discovery won't bring them back (revoke leaves the original MandateAuthorized event behind).
  const doClearRevoked = () =>
    run('Clearing…', async () => {
      const gone = subs.filter((s) => s.mandate?.status === MandateStatus.Revoked).map((s) => s.id);
      if (gone.length === 0) return;
      const dismissed = new Set(JSON.parse(localStorage.getItem(`${ns}:dismissed`) ?? '[]') as string[]);
      gone.forEach((d) => dismissed.add(d));
      localStorage.setItem(`${ns}:dismissed`, JSON.stringify([...dismissed]));
      localStorage.setItem(`${ns}:mandates`, JSON.stringify(mandateIds().filter((id) => !dismissed.has(id))));
      setSubs((prev) => prev.filter((s) => s.mandate?.status !== MandateStatus.Revoked));
      if (chartFor && gone.includes(chartFor)) setChartFor(null);
      return `Cleared ${gone.length} revoked subscription${gone.length > 1 ? 's' : ''}`;
    });

  // Read a plan's REAL terms from chain (same neutral read the checkout uses) before authorizing.
  const doReview = () =>
    run('Loading plan terms…', async () => {
      const id = planIdInput.trim();
      if (!id) return;
      const p = await isub.quoteFromPlan(id);
      setQuotedPlan(p);
      setSubMaxPerCharge(p.mode === ChargeMode.Fixed ? '' : fmtSui(p.rateCap)); // PAYG: default per-charge cap = rate cap
      return `Loaded terms for ${shortId(p.id)}`;
    });

  // One-click re-subscribe from a revoked row. Revoke is terminal (you can't un-revoke), so the way
  // back is a NEW mandate on the SAME plan — this loads that plan into the Subscribe form below. It
  // reads the plan id off the mandate (the row only shows the mandate id), avoiding the dead-end where
  // pasting the mandate id into the plan field makes `quoteFromPlan` throw.
  const doResubscribe = (planId: string) =>
    run('Loading plan terms…', async () => {
      setPlanIdInput(planId);
      const p = await isub.quoteFromPlan(planId);
      setQuotedPlan(p);
      setSubMaxPerCharge(p.mode === ChargeMode.Fixed ? '' : fmtSui(p.rateCap));
      return `Loaded ${shortId(p.id)} — set your budget below and Subscribe`;
    });

  // Actively subscribe: authorize a capped, revocable mandate against the reviewed plan. Opens an
  // account first if needed. Terms (price/rate/merchant/keeper) are bound from the chain-read plan,
  // not from any merchant input — the same invariant the checkout enforces. Moves NO funds.
  const doSubscribe = () =>
    run('Subscribing…', async () => {
      const p = quotedPlan;
      if (!p) return;
      let acct = accountId;
      if (!acct) {
        const { accountId: id } = await isub.openAccount(signer!);
        localStorage.setItem(`${ns}:account`, id);
        setAccountId(id);
        try { await gw.ingestAccount(id); } catch { /* gateway down — discoverable later */ }
        acct = id;
      }
      const budget = toMist(subBudget);
      const expiryMs = BigInt(Date.now() + Math.max(1, Number(subTtlDays) || 0) * DAY_MS);
      let mandateId: string;
      if (p.mode === ChargeMode.Fixed) {
        ({ mandateId } = await isub.authorizeFixed(signer!, {
          accountId: acct, planId: p.id,
          expectedPrice: p.price, expectedIntervalMs: p.intervalMs, expectedMerchant: p.merchant,
          totalBudget: budget, expiryMs,
        }));
      } else {
        ({ mandateId } = await isub.authorizeMetered(signer!, {
          accountId: acct, planId: p.id,
          expectedRateCap: p.rateCap, expectedRateWindowMs: p.rateWindowMs,
          expectedMerchant: p.merchant, expectedKeeper: p.keeper,
          totalBudget: budget, expiryMs,
          maxPerCharge: subMaxPerCharge ? toMist(subMaxPerCharge) : p.rateCap,
        }));
      }
      const ids = [...new Set([...mandateIds(), mandateId])];
      localStorage.setItem(`${ns}:mandates`, JSON.stringify(ids));
      try { await gw.ingestMandate(mandateId); } catch { /* gateway down — local only */ }
      setQuotedPlan(null);
      setPlanIdInput('');
      await refreshSubs(acct, ids);
      await refreshWallet();
      return `Subscribed — mandate ${shortId(mandateId)}`;
    });

  const doRevoke = (id: string) =>
    run('Cancelling…', async () => {
      await isub.revoke(signer!, { mandateId: id });
      await refreshSubs(accountId, mandateIds());
      return `Unsubscribed — ${shortId(id)} is revoked`;
    });
  const doPause = (id: string) =>
    run('Pausing…', async () => {
      await isub.pause(signer!, { mandateId: id });
      await refreshSubs(accountId, mandateIds());
      return `Paused ${shortId(id)}`;
    });
  const doResume = (id: string) =>
    run('Resuming…', async () => {
      await isub.resume(signer!, { mandateId: id });
      await refreshSubs(accountId, mandateIds());
      return `Resumed ${shortId(id)}`;
    });

  return (
    <main className="shell">
      <h2 className="sr-only">iSub subscriber dashboard</h2>
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: '1.75rem' }}>
        <Link href="/" aria-label="iSub home"><Logo size={18} /></Link>
        <div className="row" style={{ gap: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>{network}</span>
          <ConnectButton />
        </div>
      </header>

      {!connected ? (
        <Card>
          <h3 style={{ fontSize: 15, marginBottom: 8 }}>Connect your wallet to sign in</h3>
          <p className="muted" style={{ fontSize: 14, marginBottom: 14 }}>
            No password, no custodial account — your wallet is your identity. Funds stay in your wallet; you can withdraw anytime.
          </p>
          <ConnectButton />
        </Card>
      ) : (
        <>
          <section className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Your balances</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
              <div className="metric">
                <p className="label">Wallet</p>
                <p className="value amount">{walletBalance == null ? '—' : `${fmtSui(walletBalance)} SUI`}</p>
                <p className="label" style={{ margin: '6px 0 0' }}>your wallet’s own SUI — gas & deposits</p>
              </div>
              <div className="metric">
                <p className="label">iSub account</p>
                <p className="value amount">{accountId ? (balance == null ? '—' : `${fmtSui(balance)} SUI`) : 'not opened'}</p>
                <p className="label" style={{ margin: '6px 0 0' }}>deposited — funds your subscriptions · withdraw anytime</p>
              </div>
            </div>
            {accountId ? (
              <>
                <div className="row" style={{ marginBottom: 12 }}>
                  <span className="muted" style={{ fontSize: 12 }}>account</span>
                  <AddressChip id={accountId} />
                </div>
                <div className="row">
                  <input className="input" style={{ width: 120 }} value={depositSui} onChange={(e) => setDepositSui(e.target.value)} aria-label="deposit amount in SUI" />
                  <span className="muted" style={{ fontSize: 13 }}>SUI</span>
                  <Button onClick={doDeposit} disabled={!!busy} variant="primary">Deposit</Button>
                  <Button onClick={doWithdrawAll} disabled={!!busy}>Withdraw all</Button>
                </div>
              </>
            ) : (
              <>
                <p className="muted" style={{ fontSize: 14, marginBottom: 12 }}>
                  Open a reusable iSub balance you control — deposit from your wallet, withdraw anytime, no pre-funding lock-in.
                </p>
                <Button onClick={doOpen} disabled={!!busy} variant="primary">Open account</Button>
              </>
            )}
          </section>

          {exposure && (
            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
              <Metric label="Balance" value={`${fmtSui(exposure.balance)} SUI`} />
              <Metric label="Total authorized" value={`${fmtSui(exposure.totalAuthorized)} SUI`} />
              <Metric label="At risk" value={`${fmtSui(exposure.atRisk)} SUI`} hint={exposure.overAuthorized ? 'over-authorized' : 'within balance'} />
            </section>
          )}

          <WalletUsageTable mandateIds={subs.map((s) => s.id)} />

          <section className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 15, marginBottom: 4 }}>Subscribe to a plan</h3>
            <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
              Paste a merchant’s plan id, review the on-chain terms, set your own caps, and authorize. Authorizing moves no
              funds — funds stay in your wallet and you can cancel anytime.
            </p>
            <div className="row">
              <input
                className="input"
                style={{ flex: 1, minWidth: 220, fontFamily: 'var(--mono)', fontSize: 13 }}
                placeholder="plan id (0x…)"
                value={planIdInput}
                onChange={(e) => { setPlanIdInput(e.target.value); setQuotedPlan(null); }}
                aria-label="plan id to subscribe to"
              />
              <Button onClick={doReview} disabled={!!busy || !planIdInput.trim()}>Review terms</Button>
            </div>

            {quotedPlan && (
              <div style={{ borderTop: '0.5px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                  <span className="muted">mode</span>
                  <span>{quotedPlan.mode === ChargeMode.Fixed ? 'Subscription (Fixed)' : 'Pay-as-you-go'}</span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                  <span className="muted">{quotedPlan.mode === ChargeMode.Fixed ? 'price' : 'rate cap'}</span>
                  <span className="mono">
                    {quotedPlan.mode === ChargeMode.Fixed
                      ? `${fmtSui(quotedPlan.price)} SUI / ${Number(quotedPlan.intervalMs) / 1000}s`
                      : `${fmtSui(quotedPlan.rateCap)} SUI / ${Number(quotedPlan.rateWindowMs) / 1000}s window`}
                  </span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                  <span className="muted">to merchant</span>
                  <AddressChip id={quotedPlan.merchant} />
                </div>

                <div className="row" style={{ marginTop: 10 }}>
                  <label className="muted" style={{ fontSize: 12, width: 124 }}>Budget cap (SUI)</label>
                  <input className="input" style={{ width: 120 }} value={subBudget} onChange={(e) => setSubBudget(e.target.value)} aria-label="total budget in SUI" />
                </div>
                {quotedPlan.mode !== ChargeMode.Fixed && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <label className="muted" style={{ fontSize: 12, width: 124 }}>Max per charge (SUI)</label>
                    <input className="input" style={{ width: 120 }} value={subMaxPerCharge} onChange={(e) => setSubMaxPerCharge(e.target.value)} aria-label="max per charge in SUI" />
                  </div>
                )}
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="muted" style={{ fontSize: 12, width: 124 }}>Expires in (days)</label>
                  <input className="input" style={{ width: 120 }} value={subTtlDays} onChange={(e) => setSubTtlDays(e.target.value)} aria-label="expiry in days" />
                </div>

                <p style={{ fontSize: 12, color: 'var(--success)', margin: '12px 0' }}>✓ Authorizing moves no funds · cancel anytime</p>
                <div className="row">
                  <Button onClick={doSubscribe} disabled={!!busy} variant="primary">{busy ?? 'Subscribe'}</Button>
                  <Button onClick={() => { setQuotedPlan(null); setPlanIdInput(''); }} disabled={!!busy}>Cancel</Button>
                </div>
                {!accountId && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>No iSub account yet — subscribing opens one for you. Deposit afterward so charges can settle.</p>
                )}
                {accountId && balance === 0n && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Tip: your iSub balance is 0 — deposit so the merchant’s charges can settle.</p>
                )}
              </div>
            )}
          </section>

          <section className="card">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ fontSize: 15 }}>Your subscriptions</h3>
              <ExportReportButton party="subscriber" address={address} />
            </div>
            <div className="row" style={{ marginBottom: 14 }}>
              <input className="input" style={{ flex: 1, minWidth: 220, fontFamily: 'var(--mono)', fontSize: 13 }} placeholder="track a mandate id (0x…)" value={trackId} onChange={(e) => setTrackId(e.target.value)} aria-label="mandate id to track" />
              <Button onClick={doTrack} disabled={!!busy || !trackId.trim()}>Track</Button>
            </div>

            {subs.some((s) => !s.mandate) && (
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14, marginTop: -2 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  {subs.filter((s) => !s.mandate).length} unreadable record{subs.filter((s) => !s.mandate).length > 1 ? 's' : ''} — deleted, wrong network, or stale
                </span>
                <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={doClearUnreadable} disabled={!!busy}>Clear unreadable</button>
              </div>
            )}

            {subs.some((s) => s.mandate?.status === MandateStatus.Revoked) && (
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14, marginTop: -2 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  {subs.filter((s) => s.mandate?.status === MandateStatus.Revoked).length} revoked subscription{subs.filter((s) => s.mandate?.status === MandateStatus.Revoked).length > 1 ? 's' : ''} — no longer chargeable
                </span>
                <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={doClearRevoked} disabled={!!busy}>Clear revoked</button>
              </div>
            )}

            {subs.length === 0 && <p className="muted" style={{ fontSize: 14 }}>No subscriptions yet. Subscribe via a merchant’s iSub checkout, then track it here.</p>}

            {subs.map(({ id, mandate: m }) => (
              <div key={id} style={{ borderTop: '0.5px solid var(--border)', padding: '12px 0' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <AddressChip id={id} />
                  <div className="row" style={{ gap: 8 }}>
                    {m ? statusBadge(m.status) : <Badge kind="neutral">unreadable</Badge>}
                    <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setChartFor(chartFor === id ? null : id)}>
                      {chartFor === id ? 'Hide usage' : 'Usage'}
                    </button>
                  </div>
                </div>
                {m && (
                  <>
                    <div className="row" style={{ gap: 16, margin: '8px 0' }}>
                      <span className="muted" style={{ fontSize: 13 }}>{m.mode === ChargeMode.Fixed ? 'Subscription' : 'Pay-as-you-go'}</span>
                      <span className="amount" style={{ fontSize: 13 }}>{fmtSui(m.spentTotal)} / {fmtSui(m.totalBudget)} SUI</span>
                      <span className="muted mono" style={{ fontSize: 12 }}>→ {shortId(m.merchant)}</span>
                    </div>
                    {m.status === MandateStatus.Active && (
                      <div className="row">
                        <Button onClick={() => doPause(id)} disabled={!!busy}>Pause</Button>
                        <Button onClick={() => doRevoke(id)} disabled={!!busy}>Unsubscribe</Button>
                      </div>
                    )}
                    {m.status === MandateStatus.Paused && (
                      <div className="row">
                        <Button onClick={() => doResume(id)} disabled={!!busy}>Resume</Button>
                        <Button onClick={() => doRevoke(id)} disabled={!!busy}>Unsubscribe</Button>
                      </div>
                    )}
                    {m.status === MandateStatus.Revoked && (
                      <div className="row">
                        <Button onClick={() => doResubscribe(m.planId)} disabled={!!busy}>Re-subscribe</Button>
                      </div>
                    )}
                    {m.mode === ChargeMode.Payg && m.status === MandateStatus.Active && (
                      <X402AgentExport mandate={m} network={network} signMessage={signMessage} />
                    )}
                  </>
                )}
                {chartFor === id && <UsageChart mandateId={id} />}
              </div>
            ))}
          </section>

          <div style={{ marginTop: 14, minHeight: 22 }}>
            {busy && <span className="muted" style={{ fontSize: 13 }}>{busy}</span>}
            {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>✗ {error}</span>}
            {info && <span style={{ color: 'var(--success)', fontSize: 13 }}>✓ {info}</span>}
          </div>
        </>
      )}
    </main>
  );
}

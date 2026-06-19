'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { MandateStatus, ChargeMode, errorName, abortCodeOf, accountExposure, type MandateState } from '@isub/sdk';
import { useIsub } from '@/lib/use-isub';
import { fmtSui, toMist, shortId } from '@/lib/format';
import { Card, Metric, Badge, Button, AddressChip } from '@/components/ui';

type Sub = { id: string; mandate: MandateState | null };
type Exposure = Awaited<ReturnType<typeof accountExposure>>;

function statusBadge(s: MandateStatus) {
  if (s === MandateStatus.Active) return <Badge kind="accent">Active</Badge>;
  if (s === MandateStatus.Paused) return <Badge kind="warning">Paused</Badge>;
  return <Badge kind="neutral">Revoked</Badge>;
}

export default function SubscriberDashboard() {
  const { isub, signer, address, connected, network } = useIsub();
  const ns = `isub:${network}:${address ?? '-'}`;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [exposure, setExposure] = useState<Exposure | null>(null);
  const [depositSui, setDepositSui] = useState('0.1');
  const [trackId, setTrackId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

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

  const refreshSubs = useCallback(
    async (id: string | null, ids: string[]) => {
      const rows = ids.length ? await isub.getMandatesResolved(ids) : [];
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

  useEffect(() => {
    setError(null);
    setInfo(null);
    if (!address) {
      setAccountId(null);
      setBalance(null);
      setSubs([]);
      setExposure(null);
      return;
    }
    const acc = localStorage.getItem(`${ns}:account`);
    const ids = JSON.parse(localStorage.getItem(`${ns}:mandates`) ?? '[]') as string[];
    setAccountId(acc);
    if (acc) void refreshAccount(acc);
    void refreshSubs(acc, ids);
  }, [address, ns, refreshAccount, refreshSubs]);

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
      await refreshAccount(id);
      return `Account opened — ${shortId(id)}`;
    });

  const doDeposit = () =>
    run('Depositing…', async () => {
      const amount = toMist(depositSui);
      await isub.deposit(signer!, { accountId: accountId!, amount });
      await refreshAccount(accountId!);
      return `Deposited ${fmtSui(amount)} SUI`;
    });

  const doWithdrawAll = () =>
    run('Withdrawing…', async () => {
      await isub.withdrawAll(signer!, { accountId: accountId! });
      await refreshAccount(accountId!);
      return 'Withdrew full balance back to your wallet';
    });

  const doTrack = () =>
    run('Tracking subscription…', async () => {
      const id = trackId.trim();
      if (!id) return;
      const ids = [...new Set([...mandateIds(), id])];
      localStorage.setItem(`${ns}:mandates`, JSON.stringify(ids));
      setTrackId('');
      await refreshSubs(accountId, ids);
      return `Now watching ${shortId(id)}`;
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
        <Link href="/" style={{ fontSize: 18, fontWeight: 500 }}>iSub</Link>
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
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Your account</h3>
            {accountId ? (
              <>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
                  <AddressChip id={accountId} />
                  <span className="amount" style={{ fontSize: 22, fontWeight: 500 }}>{balance == null ? '—' : `${fmtSui(balance)} SUI`}</span>
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
                  Open a reusable balance you control. Withdraw anytime — no pre-funding lock-in.
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

          <section className="card">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ fontSize: 15 }}>Your subscriptions</h3>
            </div>
            <div className="row" style={{ marginBottom: 14 }}>
              <input className="input" style={{ flex: 1, minWidth: 220, fontFamily: 'var(--mono)', fontSize: 13 }} placeholder="track a mandate id (0x…)" value={trackId} onChange={(e) => setTrackId(e.target.value)} aria-label="mandate id to track" />
              <Button onClick={doTrack} disabled={!!busy || !trackId.trim()}>Track</Button>
            </div>

            {subs.length === 0 && <p className="muted" style={{ fontSize: 14 }}>No subscriptions yet. Subscribe via a merchant’s iSub checkout, then track it here.</p>}

            {subs.map(({ id, mandate: m }) => (
              <div key={id} style={{ borderTop: '0.5px solid var(--border)', padding: '12px 0' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <AddressChip id={id} />
                  {m ? statusBadge(m.status) : <Badge kind="neutral">unreadable</Badge>}
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
                  </>
                )}
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

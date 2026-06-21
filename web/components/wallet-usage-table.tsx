'use client';
import { useEffect, useState } from 'react';
import { webGateway, type UsagePointJson, type ChargePointJson } from '@/lib/gateway';
import { fmtSui } from '@/lib/format';

const gw = webGateway();
const REFRESH_MS = 5000; // re-poll so interval charges roll into the trailing windows live

// Trailing (cumulative) windows: each total counts everything within the last <ms>, so 1h ⊆ 1d ⊆ 1 week ⊆ 1 month.
const WINDOWS: { label: string; ms: number }[] = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '1d', ms: 24 * 60 * 60 * 1000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '1 month', ms: 30 * 24 * 60 * 60 * 1000 },
];

type Pt = { amount: bigint; atMs: number };

// Wallet-wide rolling usage totals across ALL of the connected (non-custodial) wallet's subscriptions.
// Per mandate it uses the same source as the per-mandate chart: metered usage (`usage_records`) when
// present, else settlements (`charges`) — so each mandate contributes from one source (no double-count).
// Summed across mandates into trailing 1h / 1d / 1 week / 1 month windows. Data comes from the managed
// gateway index (only mandates billed through it have any) — all-zeros until a subscription is metered or charged.
export function WalletUsageTable({ mandateIds }: { mandateIds: string[] }) {
  const [data, setData] = useState<{ pts: Pt[]; now: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = mandateIds.join(',');

  useEffect(() => {
    let live = true;
    if (mandateIds.length === 0) {
      setData({ pts: [], now: Date.now() });
      setErr(null);
      return;
    }
    const load = async (): Promise<void> => {
      try {
        const per = await Promise.all(
          mandateIds.map(async (id): Promise<Pt[]> => {
            const [usage, charges] = await Promise.all([
              gw.usage(id).catch(() => [] as UsagePointJson[]),
              gw.charges(id).catch(() => [] as ChargePointJson[]),
            ]);
            if (usage.length) return usage.map((u) => ({ amount: BigInt(u.amount), atMs: u.atMs }));
            return charges
              .filter((c) => c.amount != null)
              .map((c) => ({ amount: BigInt(c.amount as string), atMs: c.atMs }));
          }),
        );
        if (live) {
          setData({ pts: per.flat(), now: Date.now() });
          setErr(null);
        }
      } catch {
        if (live) setErr('usage unavailable — is the gateway running?');
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS); // live-refresh; updates in place (no loading flicker)
    return () => {
      live = false;
      clearInterval(t);
    };
    // key encodes mandateIds; re-run when the set of mandates changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const rows = data
    ? WINDOWS.map((w) => {
        let total = 0n;
        let count = 0;
        for (const p of data.pts) {
          const age = data.now - p.atMs;
          if (age >= 0 && age <= w.ms) {
            total += p.amount;
            count++;
          }
        }
        return { label: w.label, total, count };
      })
    : [];

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <h3 style={{ fontSize: 15 }}>Wallet usage</h3>
        <span className="muted" style={{ fontSize: 12 }}>across all subscriptions</span>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
        Metered usage and settlements pulled from your wallet, totalled over each trailing window.
      </p>

      {mandateIds.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>No subscriptions yet — usage appears once you subscribe.</p>
      ) : !data ? (
        err ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>{err}</p>
        ) : (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>loading usage…</p>
        )
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr className="muted" style={{ fontSize: 12, textAlign: 'left' }}>
                <th style={{ fontWeight: 400, padding: '0 0 6px' }}>Window</th>
                <th style={{ fontWeight: 400, padding: '0 0 6px', textAlign: 'right' }}>Total (SUI)</th>
                <th style={{ fontWeight: 400, padding: '0 0 6px', textAlign: 'right' }}>Events</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} style={{ borderTop: '0.5px solid var(--border)' }}>
                  <td style={{ padding: '8px 0', fontSize: 13 }}>{r.label}</td>
                  <td className="amount" style={{ padding: '8px 0', fontSize: 13, textAlign: 'right' }}>{fmtSui(r.total)}</td>
                  <td className="muted" style={{ padding: '8px 0', fontSize: 13, textAlign: 'right' }}>{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.pts.length === 0 && (
            <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
              No metered usage or settlements recorded yet — they populate once this wallet’s subscriptions are billed.
            </p>
          )}
        </>
      )}
    </section>
  );
}

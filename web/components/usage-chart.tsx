'use client';
import { useEffect, useState } from 'react';
import { webGateway, type UsagePointJson, type ChargePointJson } from '@/lib/gateway';
import { fmtSui } from '@/lib/format';

const gw = webGateway();
const REFRESH_MS = 5000; // re-poll the gateway so new charges (keeper bills on interval) show live
type Pt = { amount: bigint; atMs: number; label: string };

// Per-mandate usage chart. Prefers the PAYG metered-usage series (`usage_records`); falls back to the
// settlement series (`charges`) for Fixed plans. Pure dep-free SVG. Data comes from the gateway index
// (only mandates billed through the managed gateway have it) — empty otherwise.
export function UsageChart({ mandateId }: { mandateId: string }) {
  const [series, setSeries] = useState<{ kind: 'usage' | 'charges'; pts: Pt[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const [usage, charges] = await Promise.all([
          gw.usage(mandateId).catch(() => [] as UsagePointJson[]),
          gw.charges(mandateId).catch(() => [] as ChargePointJson[]),
        ]);
        if (!live) return;
        if (usage.length) {
          setSeries({ kind: 'usage', pts: usage.map((u) => ({ amount: BigInt(u.amount), atMs: u.atMs, label: u.meterKey ?? 'usage' })) });
        } else {
          setSeries({ kind: 'charges', pts: charges.filter((c) => c.amount != null).map((c) => ({ amount: BigInt(c.amount as string), atMs: c.atMs, label: `seq ${c.seq ?? '?'}` })) });
        }
        setErr(null);
      } catch {
        if (live) setErr('usage unavailable — is the gateway running?');
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS); // live-refresh so interval charges appear without a reload
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [mandateId]);

  // Once we have a series, keep showing it through transient poll errors (don't blank the chart).
  if (!series) return <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>{err ?? 'loading usage…'}</p>;
  if (series.pts.length === 0) return <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>No usage or charges yet — they appear once this subscription is metered or charged.</p>;

  const pts = series.pts;
  const total = pts.reduce((s, p) => s + p.amount, 0n);
  const maxN = Math.max(...pts.map((p) => Number(p.amount)), 1);
  const W = 560;
  const H = 120;
  const pad = 8;
  const innerH = H - pad * 2;
  const step = (W - pad * 2) / pts.length;
  const bw = Math.max(2, Math.min(26, step - 3));
  const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div style={{ marginTop: 10, background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>{series.kind === 'usage' ? 'Metered usage' : 'Settlements'} · {pts.length} event{pts.length > 1 ? 's' : ''}</span>
        <span className="amount" style={{ fontSize: 13, fontWeight: 500 }}>{fmtSui(total)} SUI total</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`usage chart: ${pts.length} points totalling ${fmtSui(total)} SUI`} style={{ display: 'block' }}>
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--border)" strokeWidth="1" />
        {pts.map((p, i) => {
          const h = Math.max(1, (Number(p.amount) / maxN) * innerH);
          const x = pad + i * step + (step - bw) / 2;
          return (
            <rect key={i} x={x} y={H - pad - h} width={bw} height={h} rx="2" fill="var(--accent)" opacity={0.85}>
              <title>{`${p.label} · ${fmtSui(p.amount)} SUI · ${new Date(p.atMs).toLocaleString()}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 2 }}>
        <span className="muted" style={{ fontSize: 11 }}>{fmtDate(pts[0]!.atMs)}</span>
        <span className="muted" style={{ fontSize: 11 }}>{fmtDate(pts[pts.length - 1]!.atMs)}</span>
      </div>
    </div>
  );
}

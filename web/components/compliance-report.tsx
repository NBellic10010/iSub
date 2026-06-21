'use client';
import { useState } from 'react';
import { reportUrl } from '@/lib/gateway';
import { Button } from '@/components/ui';

// On-demand monthly compliance / reconciliation report export. Fetches the gateway's /report CSV for
// the connected wallet (current calendar month, UTC) and triggers a browser download. Same component
// serves the subscriber view ("payments made") and the merchant view ("payments received") — only
// `party` differs. Each row carries the on-chain tx digest + a suiscan audit link.
export function ExportReportButton({ party, address }: { party: 'subscriber' | 'merchant'; address: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const download = async (): Promise<void> => {
    if (!address) { setErr('connect your wallet first'); return; }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(reportUrl(party, address)); // current month, CSV
      if (!r.ok) throw new Error(`gateway ${r.status} — is it running?`);
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? `isub-${party}-report.csv`;
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const label = party === 'subscriber' ? 'Export this month’s statement (CSV)' : 'Export this month’s revenue report (CSV)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Button onClick={download} disabled={busy || !address}>{busy ? 'Generating…' : label}</Button>
      {err && <span style={{ color: 'var(--danger)', fontSize: 12 }}>✗ {err}</span>}
    </span>
  );
}

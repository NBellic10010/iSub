'use client';
import dynamic from 'next/dynamic';

// Wallet UI (dApp-kit) touches browser globals at module-eval, so it must never be
// server-rendered/prerendered. Load the dashboard client-only — correct for a wallet app.
const Dashboard = dynamic(() => import('@/components/subscriber-dashboard'), {
  ssr: false,
  loading: () => <main className="shell"><p className="muted" style={{ fontSize: 14 }}>Loading…</p></main>,
});

export default function Page() {
  return <Dashboard />;
}

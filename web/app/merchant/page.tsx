import Link from 'next/link';

export default function Merchant() {
  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: '1.75rem' }}>
        <Link href="/" style={{ fontSize: 18, fontWeight: 500 }}>iSub</Link>
        <span className="muted" style={{ fontSize: 13 }}>merchant</span>
      </header>

      <div className="card">
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>Merchant dashboard — building next</h3>
        <p className="muted" style={{ fontSize: 14, marginBottom: 12 }}>
          Sign in with your wallet (SIWS session) to manage plans, subscribers, revenue, usage & invoices, webhooks and API keys.
        </p>
        <ul className="muted" style={{ fontSize: 14, lineHeight: 1.8, paddingLeft: 18, margin: 0 }}>
          <li>Plans — create Fixed / PAYG, set the RateCard</li>
          <li>Subscribers — mandates, spent vs budget, refunds</li>
          <li>Revenue — on-chain ledger + schedule-lag (missed revenue)</li>
          <li>Usage & invoices — priced line items, settlement invoices</li>
          <li>Settings — API keys, webhooks, keeper/biller health</li>
        </ul>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
          Off-chain data comes from the gateway via the typed seam in <span className="mono">lib/gateway.ts</span> (reuses the existing
          IsubGateway routes; dashboard-read endpoints are the next addition).
        </p>
      </div>
    </main>
  );
}

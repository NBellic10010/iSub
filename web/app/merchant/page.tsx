import Link from 'next/link';

export default function Merchant() {
  const items = [
    { href: '/merchant/plans', title: 'Plans', desc: 'Publish Fixed / PAYG plans, set pricing, get the checkout embed.', ready: true },
    { href: '/merchant/plans', title: 'Subscribers', desc: 'Mandates against your plans — spent vs budget, refunds.', ready: false },
    { href: '/merchant/plans', title: 'Revenue', desc: 'On-chain ledger, schedule-lag (missed revenue), invoices.', ready: false },
    { href: '/merchant/plans', title: 'Settings', desc: 'Payout address, API keys, webhooks, keeper health.', ready: false },
  ];
  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: '1.75rem' }}>
        <Link href="/" style={{ fontSize: 18, fontWeight: 500 }}>iSub</Link>
        <span className="muted" style={{ fontSize: 13 }}>merchant</span>
      </header>

      <h1 style={{ fontSize: 24, marginBottom: 6 }}>Merchant dashboard</h1>
      <p className="muted" style={{ fontSize: 15, marginBottom: 24 }}>
        Publish subscriptions and metered plans, then embed iSub checkout on your site. You collect on-chain and can refund —
        but you can never pause, cancel, or move a subscriber’s funds. They stay in control.
      </p>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        {items.map((it, i) => (
          <Link key={i} href={it.href} className="card" style={{ opacity: it.ready ? 1 : 0.6 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <h3 style={{ fontSize: 15 }}>{it.title}</h3>
              {!it.ready && <span className="muted" style={{ fontSize: 11 }}>soon</span>}
            </div>
            <p className="muted" style={{ fontSize: 14 }}>{it.desc}</p>
          </Link>
        ))}
      </section>
    </main>
  );
}

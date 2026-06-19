import Link from 'next/link';

export default function Home() {
  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: '3rem' }}>
        <span style={{ fontSize: 18, fontWeight: 500 }}>iSub</span>
        <span className="muted" style={{ fontSize: 13 }}>non-custodial subscriptions on Sui</span>
      </header>

      <section style={{ maxWidth: 640, margin: '2rem 0 2.5rem' }}>
        <h1 style={{ fontSize: 34, lineHeight: 1.15, marginBottom: 16 }}>
          Recurring & metered payments,<br />the user always in control.
        </h1>
        <p className="muted" style={{ fontSize: 17, lineHeight: 1.6 }}>
          Authorize a capped, revocable mandate once. Charges pull within your budget and settle on-chain.
          Funds stay in your wallet — cancel or withdraw anytime. The payment rail for subscriptions and the AI agent economy.
        </p>
      </section>

      <div className="row" style={{ gap: 12, marginBottom: '3rem' }}>
        <Link href="/app" className="btn btn-primary">Open my account</Link>
        <Link href="/merchant" className="btn">For merchants</Link>
      </div>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        <div className="card">
          <h3 style={{ fontSize: 15, marginBottom: 6 }}>Non-custodial</h3>
          <p className="muted" style={{ fontSize: 14 }}>Your money stays in your account. No one can over-charge or freeze it.</p>
        </div>
        <div className="card">
          <h3 style={{ fontSize: 15, marginBottom: 6 }}>Capped & revocable</h3>
          <p className="muted" style={{ fontSize: 14 }}>Per-charge and total budget caps, enforced on-chain. Revoke anytime.</p>
        </div>
        <div className="card">
          <h3 style={{ fontSize: 15, marginBottom: 6 }}>Verifiable on-chain</h3>
          <p className="muted" style={{ fontSize: 14 }}>Every charge is a settled, tamper-evident event anyone can verify.</p>
        </div>
      </section>
    </main>
  );
}

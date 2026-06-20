import Link from 'next/link';

export default function Home() {
  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <span style={{ fontSize: 18, fontWeight: 500 }}>iSub</span>
          <div className="row" style={{ gap: 22 }}>
            <Link href="/merchant" className="link">Merchants</Link>
            <Link href="/app" className="link">Subscribers</Link>
            <Link href="/app" className="btn">Open app</Link>
          </div>
        </div>
      </nav>

      <section className="wrap" style={{ padding: '5.5rem 24px 3.5rem' }}>
        <div className="pill" style={{ marginBottom: 26 }}><span className="dot" />Non-custodial payments on Sui</div>
        <h1 className="hero-h1" style={{ maxWidth: 880 }}>
          Subscriptions and metered billing,<br />
          <span className="gradient-text">the user always in control.</span>
        </h1>
        <p className="muted" style={{ fontSize: 19, lineHeight: 1.55, maxWidth: 620, margin: '24px 0 32px' }}>
          Authorize a capped, revocable mandate once. Charges pull within budget and settle on-chain — funds never leave
          the user’s wallet. The payment rail for subscriptions and the AI agent economy.
        </p>
        <div className="row" style={{ gap: 12, marginBottom: 30 }}>
          <Link href="/app" className="btn btn-primary btn-lg">Open my account</Link>
          <Link href="/merchant" className="btn btn-lg">Start as a merchant</Link>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {['No pre-funding', 'Cancel anytime', 'On-chain verifiable', 'Sub-cent metering'].map((t) => (
            <span key={t} className="pill">{t}</span>
          ))}
        </div>
      </section>

      <section className="wrap" style={{ padding: '2.5rem 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 36, alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 27, letterSpacing: '-0.02em', marginBottom: 12 }}>Integrate checkout in minutes</h2>
          <p className="muted" style={{ fontSize: 16, lineHeight: 1.6, marginBottom: 16 }}>
            Publish a plan, drop the embed on your site. Your customers review the real on-chain terms in an isolated
            checkout — you can collect and refund, but never pause, cancel, or touch their funds.
          </p>
          <Link href="/merchant" className="link" style={{ color: 'var(--accent)' }}>Publish a plan →</Link>
        </div>
        <pre className="codecard">
{`import { `}<span className="tok-fn">iSubCheckout</span>{` } `}<span className="tok-kw">from</span>{` `}<span className="tok-str">{'"@isub/checkout"'}</span>{`;

`}<span className="tok-fn">iSubCheckout</span>{`.`}<span className="tok-fn">open</span>{`({
  planId: `}<span className="tok-str">{'"0x…"'}</span>{`,
  budget: `}<span className="tok-str">{'"0.2"'}</span>{`, `}<span className="tok-com">{'// the user’s hard cap'}</span>{`
});
`}<span className="tok-com">{'// → { ok, mandateId } when they subscribe'}</span>
        </pre>
      </section>

      <section className="wrap" style={{ padding: '3rem 24px 1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          <Feature title="For users" desc="One funded account, many subscriptions. Per-charge and total caps enforced on-chain. Withdraw or cancel anytime." href="/app" cta="Open account" />
          <Feature title="For merchants" desc="Publish Fixed or metered plans, embed checkout, collect on-chain. Refund freely — never custody a cent." href="/merchant" cta="Start selling" />
          <Feature title="For AI agents" desc="A budget-bounded session key subscribes and pays per call, within a human-set policy. Pay-as-you-go, on-chain." href="/app" cta="Explore" />
        </div>
      </section>

      <footer className="wrap" style={{ padding: '3.5rem 24px', marginTop: '2rem', borderTop: '0.5px solid var(--border)' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 500 }}>iSub</span>
          <span className="muted" style={{ fontSize: 13 }}>Built on Sui · non-custodial by design</span>
        </div>
      </footer>
    </>
  );
}

function Feature({ title, desc, href, cta }: { title: string; desc: string; href: string; cta: string }) {
  return (
    <div className="feature">
      <h3 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h3>
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 14 }}>{desc}</p>
      <Link href={href} className="link" style={{ color: 'var(--accent)' }}>{cta} →</Link>
    </div>
  );
}

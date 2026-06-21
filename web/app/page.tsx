import Link from 'next/link';
import { Logo } from '@/components/logo';
import { HeroArt } from '@/components/hero-art';
import { CopyCommand } from '@/components/copy-command';
import { GlobeBg } from '@/components/globe-bg';
import { type ReactNode, type CSSProperties } from 'react';
import { CardSpotlight } from '@/components/card-spotlight';

// Developer handbook (GitBook). Set NEXT_PUBLIC_DOCS_URL to your published space
// (e.g. https://your-space.gitbook.io/isub or a custom domain like https://docs.isub.app).
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'https://docs.isub.app';

export default function Home() {
  return (
    <>
      <CardSpotlight />
      <nav className="nav">
        <div className="nav-inner">
          <Logo size={19} />
          <div className="row" style={{ gap: 22 }}>
            <Link href="/merchant" className="link">Merchants</Link>
            <Link href="/app" className="link">Subscribers</Link>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="link">Docs</a>
            <Link href="/app" className="btn">Open app</Link>
          </div>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-grad" aria-hidden="true" />
        <GlobeBg />
        <div
          className="wrap"
          style={{ padding: '5rem 24px 4rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 48, alignItems: 'center' }}
        >
          <div>
            <div className="pill" style={{ marginBottom: 24 }}><span className="dot" />Non-custodial payments on Sui</div>
          <h1 className="hero-h1" style={{ maxWidth: 560 }}>
            Subscriptions and metered billing,<br />
            <span className="gradient-text">the user always in control.</span>
          </h1>
          <p className="muted" style={{ fontSize: 18, lineHeight: 1.55, maxWidth: 520, margin: '22px 0 30px' }}>
            Authorize a capped, revocable mandate once. Charges pull within budget and settle on-chain — funds never leave
            the user’s wallet. The payment rail for subscriptions and the AI agent economy.
          </p>
          <div className="row" style={{ gap: 12, marginBottom: 26 }}>
            <Link href="/app" className="btn btn-primary btn-lg">Open my account</Link>
            <Link href="/merchant" className="btn btn-lg">Start as a merchant</Link>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {['No pre-funding', 'x402-native', 'Cancel anytime', 'On-chain verifiable', 'Sub-cent metering'].map((t) => (
              <span key={t} className="pill">{t}</span>
            ))}
          </div>
        </div>
          <HeroArt />
        </div>
        <div className="wrap" style={{ padding: '0 24px 2.75rem' }}>
          <div className="trustrow">
            <span className="muted" style={{ fontSize: 12.5 }}>The agent-economy stack</span>
            <span className="tlabel">Sui</span>
            <span className="tlabel">x402</span>
            <span className="tlabel">AP2</span>
            <span className="tlabel">MCP</span>
            <span className="tlabel">Walrus</span>
          </div>
        </div>
      </section>

      <section className="wrap" style={{ padding: '0.5rem 24px 1rem' }}>
        <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 24 }}>
          <Stat v="1 sig" label="Authorize once, then pull within caps" />
          <Stat v="0" label="Funds escrowed — fully non-custodial" />
          <Stat v="72/72" label="Contract tests passing" />
          <Stat v="3 modes" label="Fixed · pay-as-you-go · agent" />
        </div>
      </section>

      <section className="wrap" style={{ padding: '2.5rem 24px 1.5rem' }}>
        <Eyebrow>How it works</Eyebrow>
        <h2 style={{ fontSize: 28, letterSpacing: '-0.02em', marginBottom: 8 }}>Authorize once. Stay in control.</h2>
        <p className="muted" style={{ fontSize: 16, lineHeight: 1.6, maxWidth: 620, marginBottom: 26 }}>
          No pre-funding, no escrow — just a capped right to pull, revocable any time.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          <Step n="01" title="Authorize once" desc="Sign a capped, revocable mandate against a plan. It moves no funds — your balance stays in an account you own." />
          <Step n="02" title="Charges pull within caps" desc="A merchant or keeper pulls recurring or metered amounts. The contract enforces every cap — per-charge, rate, budget, expiry." />
          <Step n="03" title="Cancel anytime" desc="Revoke or withdraw with one signature. Non-custodial from first deposit to last charge." />
        </div>
      </section>

      <section className="wrap" style={{ padding: '2.5rem 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 36, alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 27, letterSpacing: '-0.02em', marginBottom: 12 }}>Integrate checkout in minutes</h2>
          <p className="muted" style={{ fontSize: 16, lineHeight: 1.6, marginBottom: 16 }}>
            Publish a plan, drop the embed on your site. Your customers review the real on-chain terms in an isolated
            checkout — you can collect and refund, but never pause, cancel, or touch their funds.
          </p>
          <div className="row" style={{ gap: 18 }}>
            <Link href="/merchant" className="link" style={{ color: 'var(--accent)' }}>Publish a plan →</Link>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="link" style={{ color: 'var(--accent)' }}>Read the SDK docs →</a>
          </div>
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

      <section className="wrap" style={{ padding: '3rem 24px 1.5rem' }}>
        <Eyebrow>Why iSub</Eyebrow>
        <h2 style={{ fontSize: 28, letterSpacing: '-0.02em', marginBottom: 8 }}>Safe by construction</h2>
        <p className="muted" style={{ fontSize: 16, lineHeight: 1.6, maxWidth: 640, marginBottom: 26 }}>
          Every limit is enforced by the Move contract — not a backend you have to trust.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          <Feat color="#2b7fff" title="Hard caps on-chain" desc="Per-charge ceiling, rolling rate limit, lifetime budget, and expiry — checked on every pull." />
          <Feat color="#7b5cff" title="No pre-funding" desc="Authorizing transfers zero funds. Deposit only what you need; top up as you go." />
          <Feat color="#ff6fae" title="Cancel & withdraw anytime" desc="Revoke is terminal and one signature. Your funds are always yours to pull back." />
          <Feat color="#2b7fff" title="No double-billing" desc="Metered charges are idempotent — a timed-out retry lands once, never twice." />
          <Feat color="#7b5cff" title="Refunds without custody" desc="Merchants refund into your account and collect within caps — but never hold or freeze a cent." />
          <Feat color="#ff6fae" title="One primitive, three modes" desc="Fixed subscriptions, pay-as-you-go metering, and budget-bounded agent spend." />
        </div>
      </section>

      <section className="wrap" style={{ padding: '2rem 24px' }}>
        <Eyebrow>Two ways to bill</Eyebrow>
        <h2 style={{ fontSize: 28, letterSpacing: '-0.02em', marginBottom: 22 }}>Fixed or pay-as-you-go</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
          <ModeCard tag="subscription" title="Fixed" desc="A set price every interval — the classic recurring plan." terms={[['price', '0.05 SUI / 30d'], ['gate', 'interval-gated'], ['charge', 'permissionless']]} />
          <ModeCard tag="metered" title="Pay-as-you-go" desc="Usage-priced charges, capped per rolling window. Priced by a RateCard, frozen at ingest." terms={[['rate cap', '0.1 SUI / 60s'], ['throttle', 'max per charge'], ['charge', 'merchant / keeper']]} />
        </div>
      </section>

      <section className="wrap" style={{ padding: '2rem 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 40, alignItems: 'center' }}>
        <div>
          <Eyebrow>For the agent economy</Eyebrow>
          <h2 style={{ fontSize: 26, letterSpacing: '-0.02em', marginBottom: 12 }}>Agent payments, standards-native</h2>
          <div className="row" style={{ gap: 8, marginBottom: 14 }}>
            <span className="badge accent">x402-native</span>
            <span className="badge accent">AP2-aligned</span>
            <span className="badge neutral">MCP</span>
          </div>
          <p className="muted" style={{ fontSize: 16, lineHeight: 1.6, marginBottom: 16 }}>
            iSub speaks x402 over a standing-mandate scheme — one HTTP 402 round-trip settles a recurring, metered, capped
            charge, not a one-shot transfer. That same capped, revocable mandate is the unit Google’s AP2 centers on. A
            budget-bounded session key pays per call within a human-set policy; MCP-native, every charge auditable on-chain.
          </p>
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="link" style={{ color: 'var(--accent)' }}>Agent · x402 · MCP docs →</a>
        </div>
        <pre className="codecard">
{`const agent = `}<span className="tok-kw">new</span>{` `}<span className="tok-fn">IsubAgent</span>{`(isub, key, { accountId, allowed });

`}<span className="tok-kw">await</span>{` agent.`}<span className="tok-fn">subscribe</span>{`({ service: `}<span className="tok-str">{'"gpu-api"'}</span>{`, budget: `}<span className="tok-str">{'"0.2"'}</span>{` });
`}<span className="tok-com">{'// → one capped mandate · pays x402 APIs per call'}</span>
        </pre>
      </section>

      <section className="wrap" style={{ padding: '3rem 24px 1.5rem' }}>
        <Eyebrow>Who it’s for</Eyebrow>
        <h2 style={{ fontSize: 28, letterSpacing: '-0.02em', marginBottom: 22 }}>One rail, three audiences</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          <Feature color="#2b7fff" title="For users" desc="One funded account, many subscriptions. Per-charge and total caps enforced on-chain. Withdraw or cancel anytime." href="/app" cta="Open account" />
          <Feature color="#7b5cff" title="For merchants" desc="Publish Fixed or metered plans, embed checkout, collect on-chain. Refund freely — never custody a cent." href="/merchant" cta="Start selling" />
          <Feature color="#ff6fae" title="For AI agents" desc="A budget-bounded session key subscribes and pays per call, within a human-set policy. Pay-as-you-go, on-chain." href="/app" cta="Explore" />
        </div>
      </section>

      <section id="get-started" className="wrap" style={{ padding: '3.5rem 24px 2rem', scrollMarginTop: 80 }}>
        <div className="cta-band" style={{ marginBottom: 16 }}>
          <Eyebrow>Get started</Eyebrow>
          <h2 className="cta-h2">Go live in <span className="gradient-text">minutes</span>.</h2>
          <p className="muted" style={{ fontSize: 17, lineHeight: 1.55, maxWidth: 540, margin: '0 auto 20px' }}>
            Authorize once, charge within caps, settle on-chain. No pre-funding, cancel anytime — live on Sui testnet today.
          </p>
          <CopyCommand cmd="npm i @isub/sdk @mysten/sui" />
          <p className="muted" style={{ fontSize: 12.5, marginTop: 16 }}>No pre-funding · capped, revocable · funds never leave your wallet</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(264px, 1fr))', gap: 16 }}>
          <PathCard color="#7b5cff" icon={<StoreIcon />} title="Start as a merchant" desc="Publish Fixed or metered plans, embed checkout, and collect on-chain." href="/merchant" cta="Merchant dashboard" />
          <PathCard color="#2b7fff" icon={<WalletIcon />} title="Start as a subscriber" desc="Open an account, fund it, and authorize capped, revocable mandates." href="/app" cta="Open my account" />
          <PathCard color="#ff6fae" icon={<CodeIcon />} title="Check the SDK" desc="Install @isub/sdk, wire authorize → charge, or run the gateway." href={DOCS_URL} external cta="Read the docs" />
        </div>
      </section>

      <footer className="wrap" style={{ padding: '3.5rem 24px', marginTop: '2rem', borderTop: '0.5px solid var(--border)' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Logo size={16} />
          <div className="row" style={{ gap: 18 }}>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="link">Docs</a>
            <span className="muted" style={{ fontSize: 13 }}>Built on Sui · non-custodial by design</span>
          </div>
        </div>
      </footer>
    </>
  );
}

function Feature({ color, title, desc, href, cta }: { color: string; title: string; desc: string; href: string; cta: string }) {
  return (
    <div className="feature" style={{ ['--card-accent']: color } as CSSProperties}>
      <div
        className="feat-ic"
        style={{ background: `color-mix(in srgb, ${color} 14%, var(--surface))`, border: `0.5px solid color-mix(in srgb, ${color} 30%, transparent)` }}
      >
        <Stripes color={color} />
      </div>
      <h3 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h3>
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 14 }}>{desc}</p>
      <Link href={href} className="link" style={{ color: 'var(--accent)' }}>{cta} →</Link>
    </div>
  );
}

function Eyebrow({ children }: { children: string }) {
  return <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent)', margin: '0 0 10px' }}>{children}</p>;
}

function StoreIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 9.5h14V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9.5Z" />
      <path d="M4 9.5 5.4 5h13.2L20 9.5Z" />
      <path d="M10 20v-5h4v5" />
    </svg>
  );
}
function WalletIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
function CodeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 8-4 4 4 4" />
      <path d="m15 8 4 4-4 4" />
    </svg>
  );
}

function PathCard({ color, icon, title, desc, href, cta, external }: { color: string; icon: ReactNode; title: string; desc: string; href: string; cta: string; external?: boolean }) {
  const body = (
    <div className="feature pathcard" style={{ ['--card-accent']: color } as CSSProperties}>
      <div className="feat-ic" style={{ background: `color-mix(in srgb, ${color} 14%, var(--surface))`, border: `0.5px solid color-mix(in srgb, ${color} 30%, transparent)`, color }}>
        {icon}
      </div>
      <h3 style={{ fontSize: 16, marginBottom: 7 }}>{title}</h3>
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>{desc}</p>
      <span className="link" style={{ marginTop: 'auto', color: 'var(--accent)', fontWeight: 500 }}>{cta} →</span>
    </div>
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: 'block', height: '100%' }}>{body}</a>
  ) : (
    <Link href={href} style={{ display: 'block', height: '100%' }}>{body}</Link>
  );
}

function Stat({ v, label }: { v: string; label: string }) {
  return (
    <div>
      <p style={{ fontSize: 25, fontWeight: 500, letterSpacing: '-0.02em', margin: 0 }}>{v}</p>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.45, margin: '5px 0 0' }}>{label}</p>
    </div>
  );
}

function Step({ n, title, desc }: { n: string; title: string; desc: string }) {
  return (
    <div className="feature">
      <span className="mono" style={{ fontSize: 12, color: 'var(--accent)', border: '0.5px solid var(--border)', borderRadius: 7, padding: '3px 8px' }}>{n}</span>
      <h3 style={{ fontSize: 15, margin: '14px 0 7px' }}>{title}</h3>
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>{desc}</p>
    </div>
  );
}

function Stripes({ color }: { color: string }) {
  return (
    <svg width="20" height="18" viewBox="0 0 22 20" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="0" y="2" width="22" height="3.4" rx="1.7" fill={color} />
      <rect x="0" y="8.3" width="15" height="3.4" rx="1.7" fill={color} opacity="0.7" />
      <rect x="0" y="14.6" width="9" height="3.4" rx="1.7" fill={color} opacity="0.45" />
    </svg>
  );
}

function Feat({ color, title, desc }: { color: string; title: string; desc: string }) {
  return (
    <div className="feature" style={{ ['--card-accent']: color } as CSSProperties}>
      <div
        className="feat-ic"
        style={{ background: `color-mix(in srgb, ${color} 14%, var(--surface))`, border: `0.5px solid color-mix(in srgb, ${color} 30%, transparent)` }}
      >
        <Stripes color={color} />
      </div>
      <h3 style={{ fontSize: 15, marginBottom: 7 }}>{title}</h3>
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>{desc}</p>
    </div>
  );
}

function ModeCard({ tag, title, desc, terms }: { tag: string; title: string; desc: string; terms: [string, string][] }) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ fontSize: 17 }}>{title}</h3>
        <span className="badge accent" style={{ fontSize: 11 }}>{tag}</span>
      </div>
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 12 }}>{desc}</p>
      {terms.map(([k, v]) => (
        <div key={k} className="row" style={{ justifyContent: 'space-between', fontSize: 13, padding: '6px 0', borderTop: '0.5px solid var(--border)' }}>
          <span className="muted">{k}</span>
          <span className="mono">{v}</span>
        </div>
      ))}
    </div>
  );
}

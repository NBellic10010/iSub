// Hero artwork — the logo motif (a spending cap over decreasing stripes) rendered as a glassy,
// on-chain billing statement. Decorative; mirrors concept A and the brand gradient.

const ROWS = [
  { c: '#2b7fff', w: '100%', label: 'tokens · in', amt: '0.020' },
  { c: '#7b5cff', w: '66%', label: 'tokens · out', amt: '0.012' },
  { c: '#ff6fae', w: '38%', label: 'api calls', amt: '0.001' },
];

export function HeroArt() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: '100%',
        maxWidth: 420,
        marginLeft: 'auto',
        background: 'color-mix(in srgb, var(--surface) 72%, transparent)',
        WebkitBackdropFilter: 'blur(12px)',
        backdropFilter: 'blur(12px)',
        border: '0.5px solid var(--border)',
        borderRadius: 18,
        padding: '20px 22px',
        boxShadow: '0 24px 60px -28px color-mix(in srgb, var(--accent) 45%, transparent)',
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>iSub statement</span>
        <span className="badge accent" style={{ fontSize: 11 }}>pay-as-you-go</span>
      </div>

      {/* the cap — the ceiling that bounds every charge */}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 11 }}>budget cap</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text)' }}>0.20 SUI</span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: 'var(--text)', opacity: 0.85, marginBottom: 18 }} />

      {/* line items — decreasing stripes, the brand gradient */}
      {ROWS.map((r) => (
        <div key={r.label} style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>{r.label}</span>
            <span className="mono" style={{ fontSize: 12 }}>{r.amt}</span>
          </div>
          <div style={{ height: 7, borderRadius: 4, width: r.w, background: r.c }} />
        </div>
      ))}

      <div
        className="row"
        style={{ justifyContent: 'space-between', marginTop: 18, paddingTop: 14, borderTop: '0.5px solid var(--border)' }}
      >
        <span className="muted" style={{ fontSize: 12 }}>settled on-chain · within cap</span>
        <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>0.033 SUI</span>
      </div>
    </div>
  );
}

// iSub brand mark — concept A: a spending "cap" line above three decreasing stripes
// (invoice line-items / Stripe-stripes, under a ceiling = the capped, revocable mandate).
// The cap uses currentColor so it adapts to light/dark; stripes are the brand gradient stops.

const BLUE = '#2b7fff';
const PURPLE = '#7b5cff';
const PINK = '#ff6fae';

export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={(size * 32) / 38}
      height={size}
      viewBox="0 0 32 38"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="3" width="28" height="4" rx="2" fill="currentColor" />
      <rect x="2" y="13" width="28" height="5" rx="2.5" fill={BLUE} />
      <rect x="2" y="22" width="19" height="5" rx="2.5" fill={PURPLE} />
      <rect x="2" y="31" width="11" height="5" rx="2.5" fill={PINK} />
    </svg>
  );
}

/** Mark + "iSub" wordmark lockup. `size` is the wordmark font-size in px; the mark scales with it. */
export function Logo({ size = 19, className }: { size?: number; className?: string }) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.42), lineHeight: 1 }}
    >
      <LogoMark size={Math.round(size * 1.35)} />
      <span style={{ fontSize: size, fontWeight: 500, letterSpacing: '-0.01em' }}>
        <span style={{ color: 'var(--accent)' }}>i</span>Sub
      </span>
    </span>
  );
}

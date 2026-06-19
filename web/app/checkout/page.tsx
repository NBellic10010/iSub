'use client';
import dynamic from 'next/dynamic';

// The checkout consent surface — wallet UI, so client-only (never prerendered). Embedded in an
// iframe by the merchant's site via the @isub/checkout loader; runs on iSub's origin so the
// merchant cannot restyle or spoof the terms shown to the user.
const Checkout = dynamic(() => import('@/components/checkout'), {
  ssr: false,
  loading: () => (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <p className="muted" style={{ fontSize: 14 }}>Loading…</p>
    </div>
  ),
});

export default function Page() {
  return <Checkout />;
}

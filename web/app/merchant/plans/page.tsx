'use client';
import dynamic from 'next/dynamic';

const MerchantPlans = dynamic(() => import('@/components/merchant-plans'), {
  ssr: false,
  loading: () => <main className="shell"><p className="muted" style={{ fontSize: 14 }}>Loading…</p></main>,
});

export default function Page() {
  return <MerchantPlans />;
}

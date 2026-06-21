'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { ChargeMode, errorName, abortCodeOf, type PlanState } from '@isub/sdk';
import { useIsub } from '@/lib/use-isub';
import { fmtSui, toMist, shortId } from '@/lib/format';
import { Card, Badge, Button, AddressChip } from '@/components/ui';
import { Logo } from '@/components/logo';
import { webGateway } from '@/lib/gateway';

const INTERVALS = [
  { label: '1 minute (test)', ms: 60_000n },
  { label: '1 hour', ms: 3_600_000n },
  { label: '1 day', ms: 86_400_000n },
  { label: '1 week', ms: 604_800_000n },
  { label: '30 days', ms: 2_592_000_000n },
];
const WINDOWS = [
  { label: '1 minute', ms: 60_000n },
  { label: '1 hour', ms: 3_600_000n },
  { label: '1 day', ms: 86_400_000n },
];

type Plan = { id: string; plan: PlanState | null };
const CHECKOUT_BASE = typeof window !== 'undefined' ? `${window.location.origin}/checkout` : '/checkout';
const gw = webGateway();

export default function MerchantPlans() {
  const { isub, signer, address, connected, network } = useIsub();
  const ns = `isub:${network}:${address ?? '-'}:plans`;

  const [tab, setTab] = useState<'fixed' | 'payg'>('fixed');
  const [priceSui, setPriceSui] = useState('0.01');
  const [intervalMs, setIntervalMs] = useState(INTERVALS[2]!.ms.toString());
  const [rateCapSui, setRateCapSui] = useState('0.1');
  const [windowMs, setWindowMs] = useState(WINDOWS[1]!.ms.toString());

  const [plans, setPlans] = useState<Plan[]>([]);
  const [embedFor, setEmbedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const planIds = useCallback((): string[] => JSON.parse(localStorage.getItem(ns) ?? '[]') as string[], [ns]);
  const refresh = useCallback(
    async (ids: string[]) => {
      const rows = await Promise.all(
        ids.map(async (id) => {
          try {
            return { id, plan: await isub.getPlan(id) } as Plan;
          } catch {
            return { id, plan: null } as Plan;
          }
        }),
      );
      setPlans(rows);
    },
    [isub],
  );

  // Discover plan ids from the gateway index (cross-device, by merchant address) merged with
  // locally-remembered ids; then read each plan's truth from chain. Gateway down → localStorage only.
  const loadPlans = useCallback(async () => {
    if (!address) return setPlans([]);
    const ids = new Set(planIds());
    try {
      for (const r of await gw.plansByMerchant(address)) ids.add(r.planId);
    } catch {
      /* gateway unavailable → fall back to locally-remembered ids */
    }
    await refresh([...ids]);
  }, [address, planIds, refresh]);

  useEffect(() => {
    setError(null);
    setInfo(null);
    void loadPlans();
  }, [loadPlans]);

  async function run(label: string, fn: () => Promise<string | void>): Promise<void> {
    setBusy(label);
    setError(null);
    setInfo(null);
    try {
      const msg = await fn();
      if (msg) setInfo(msg);
    } catch (e) {
      const code = abortCodeOf(e);
      setError(code != null ? `${errorName(code)} (#${code})` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const remember = (id: string) => {
    const ids = [...new Set([...planIds(), id])];
    localStorage.setItem(ns, JSON.stringify(ids));
    return ids;
  };

  const createFixed = () =>
    run('Publishing plan…', async () => {
      const { planId } = await isub.createPlanFixed(signer!, { price: toMist(priceSui), intervalMs: BigInt(intervalMs), keeper: address! });
      remember(planId);
      try { await gw.ingestPlan(planId); } catch { /* gateway down — still remembered locally */ }
      await loadPlans();
      setEmbedFor(planId);
      return `Published subscription plan — ${shortId(planId)}`;
    });

  const createPayg = () =>
    run('Publishing plan…', async () => {
      const { planId } = await isub.createPlanPayg(signer!, { rateCap: toMist(rateCapSui), rateWindowMs: BigInt(windowMs), keeper: address! });
      remember(planId);
      try { await gw.ingestPlan(planId); } catch { /* gateway down — still remembered locally */ }
      await loadPlans();
      setEmbedFor(planId);
      return `Published PAYG plan — ${shortId(planId)}`;
    });

  const deactivate = (id: string) =>
    run('Deactivating…', async () => {
      await isub.deactivatePlan(signer!, { planId: id });
      try { await gw.ingestPlan(id); } catch { /* refresh the index's active flag, best-effort */ }
      await loadPlans();
      return `Plan ${shortId(id)} taken off sale (existing subscribers unaffected)`;
    });

  return (
    <main className="shell">
      <h2 className="sr-only">iSub merchant — plans</h2>
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div className="row" style={{ gap: 16 }}>
          <Link href="/" aria-label="iSub home"><Logo size={18} /></Link>
          <nav className="row" style={{ gap: 14, fontSize: 14 }}>
            <span style={{ fontWeight: 500 }}>Plans</span>
            <span className="muted">Subscribers</span>
            <span className="muted">Revenue</span>
          </nav>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>{network}</span>
          <ConnectButton />
        </div>
      </header>

      {!connected ? (
        <Card>
          <h3 style={{ fontSize: 15, marginBottom: 8 }}>Connect your wallet to manage plans</h3>
          <p className="muted" style={{ fontSize: 14, marginBottom: 14 }}>
            Your wallet is your merchant identity — every plan you publish is paid to this address.
          </p>
          <ConnectButton />
        </Card>
      ) : (
        <>
          <section className="card" style={{ marginBottom: 16 }}>
            <div className="row" style={{ gap: 8, marginBottom: 14 }}>
              <button className={`btn ${tab === 'fixed' ? 'btn-primary' : ''}`} onClick={() => setTab('fixed')}>Subscription</button>
              <button className={`btn ${tab === 'payg' ? 'btn-primary' : ''}`} onClick={() => setTab('payg')}>Pay-as-you-go</button>
            </div>

            {tab === 'fixed' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
                <Field label="Price (SUI)">
                  <input className="input" value={priceSui} onChange={(e) => setPriceSui(e.target.value)} />
                </Field>
                <Field label="Charge every">
                  <select className="input" value={intervalMs} onChange={(e) => setIntervalMs(e.target.value)}>
                    {INTERVALS.map((i) => <option key={i.label} value={i.ms.toString()}>{i.label}</option>)}
                  </select>
                </Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Button onClick={createFixed} disabled={!!busy} variant="primary">Publish subscription plan</Button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
                <Field label="Rate cap (SUI / window)">
                  <input className="input" value={rateCapSui} onChange={(e) => setRateCapSui(e.target.value)} />
                </Field>
                <Field label="Rolling window">
                  <select className="input" value={windowMs} onChange={(e) => setWindowMs(e.target.value)}>
                    {WINDOWS.map((w) => <option key={w.label} value={w.ms.toString()}>{w.label}</option>)}
                  </select>
                </Field>
                <p className="muted" style={{ gridColumn: '1 / -1', fontSize: 12.5, margin: 0 }}>
                  Per-unit pricing (RateCard: per-token / per-call) is configured in your biller — editor coming next.
                </p>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Button onClick={createPayg} disabled={!!busy} variant="primary">Publish PAYG plan</Button>
                </div>
              </div>
            )}
          </section>

          <section className="card">
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Your plans</h3>
            {plans.length === 0 && <p className="muted" style={{ fontSize: 14 }}>No plans yet. Publish one above, then embed its checkout on your site.</p>}
            {plans.map(({ id, plan: p }) => (
              <div key={id} style={{ borderTop: '0.5px solid var(--border)', padding: '12px 0' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <AddressChip id={id} />
                  {p ? (p.active ? <Badge kind="success">On sale</Badge> : <Badge kind="neutral">Inactive</Badge>) : <Badge kind="neutral">unreadable</Badge>}
                </div>
                {p && (
                  <>
                    <div className="row" style={{ gap: 14, margin: '8px 0' }}>
                      <span className="muted" style={{ fontSize: 13 }}>{p.mode === ChargeMode.Fixed ? 'Subscription' : 'Pay-as-you-go'}</span>
                      <span className="amount" style={{ fontSize: 13 }}>
                        {p.mode === ChargeMode.Fixed
                          ? `${fmtSui(p.price)} SUI / ${Number(p.intervalMs) / 1000}s`
                          : `${fmtSui(p.rateCap)} SUI / ${Number(p.rateWindowMs) / 1000}s window`}
                      </span>
                    </div>
                    <div className="row">
                      <Button onClick={() => setEmbedFor(embedFor === id ? null : id)} disabled={!!busy}>Get checkout embed</Button>
                      {p.active && <Button onClick={() => deactivate(id)} disabled={!!busy}>Deactivate</Button>}
                    </div>
                    {embedFor === id && <Embed planId={id} />}
                  </>
                )}
              </div>
            ))}
          </section>

          <div style={{ marginTop: 14, minHeight: 22 }}>
            {busy && <span className="muted" style={{ fontSize: 13 }}>{busy}</span>}
            {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>✗ {error}</span>}
            {info && <span style={{ color: 'var(--success)', fontSize: 13 }}>✓ {info}</span>}
          </div>
        </>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="muted" style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}

/** The "publish" output: how the merchant wires this plan to the iSub checkout on their own site. */
function Embed({ planId }: { planId: string }) {
  const [copied, setCopied] = useState(false);
  const snippet = [
    `<button id="buy">Subscribe</button>`,
    `<script type="module">`,
    `  import { iSubCheckout } from "@isub/checkout";`,
    `  buy.onclick = () => iSubCheckout.open({`,
    `    planId: "${planId}",`,
    `    budget: "0.2", // the user's hard spend cap`,
    `  });`,
    `</script>`,
  ].join('\n');
  const link = `${CHECKOUT_BASE}?planId=${planId}&budget=0.2`;
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Embed on your site (your customers subscribe — you never do)</span>
        <button
          className="btn"
          style={{ padding: '4px 10px', fontSize: 12 }}
          onClick={() => {
            void navigator.clipboard?.writeText(snippet);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="mono" style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text)' }}>{snippet}</pre>
      <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
        Or a hosted link: <a href={link} style={{ color: 'var(--accent)' }} className="mono">{link.replace(/^https?:\/\//, '')}</a>
      </p>
    </div>
  );
}

'use client';
import { useState } from 'react';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bindMessage, type MandateState } from '@isub/sdk';
import { PACKAGE_IDS } from '@/lib/dapp-kit';
import { Button } from '@/components/ui';

// Per-mandate "Export x402 agent config". The CONNECTED WALLET (= this mandate's subscriber) signs an
// AgentCert binding a freshly-generated agent key, then emits the JSON the CLI agent
// (scripts/isub-x402-agent.ts) loads. Because the wallet is the subscriber, the agent pays THIS
// mandate — so charges show up on this dashboard (this wallet's account), not on a project actor.
//
// SECURITY (demo): this generates the agent key in the browser and exports its SECRET in plaintext —
// convenient for a local demo, NOT a production pattern. The cert lifetime is BOUNDED (F2) so a leaked
// key self-expires; for production, mint agent keys in a KMS/secure enclave and never export them.
const APIS = [
  { path: '/weather', price: '1000000', label: 'Weather forecast (per call)' },
  { path: '/premium-quote', price: '5000000', label: 'Premium stock quote (per call)' },
];
// F2: cap the binding cert at 30 days (and never beyond the mandate's own expiry) — not 0 (never-expire).
const CERT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function X402AgentExport({
  mandate,
  network,
  signMessage,
}: {
  mandate: MandateState;
  network: string;
  signMessage: ((message: string) => Promise<{ signature: string; address: string }>) | null;
}) {
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generate = async (): Promise<void> => {
    if (!signMessage) { setErr('connect your wallet first'); return; }
    setBusy(true);
    setErr(null);
    try {
      const agentKp = new Ed25519Keypair();
      const agent = agentKp.toSuiAddress();
      // F2: bound the cert — min(now+30d, mandate expiry) — so a leaked key self-expires (never 0/forever).
      const cap = BigInt(Date.now() + CERT_TTL_MS);
      const certNotAfter = mandate.expiryMs > 0n && mandate.expiryMs < cap ? mandate.expiryMs : cap;
      // The wallet signs the binding — it must be the mandate's subscriber, or the cert won't verify.
      const { signature, address } = await signMessage(bindMessage({ mandateId: mandate.id, agent, notAfter: certNotAfter, ver: 1 }));
      if (address !== mandate.subscriber) {
        setErr(`connected wallet ${address.slice(0, 10)}… ≠ this mandate's subscriber ${mandate.subscriber.slice(0, 10)}… — connect the subscribing wallet`);
        return;
      }
      const config = {
        network,
        packageId: PACKAGE_IDS[network] ?? PACKAGE_IDS.testnet,
        mandateId: mandate.id,
        accountId: mandate.accountId,
        payoutAddress: mandate.merchant,
        agentSecretKey: agentKp.getSecretKey(),
        cert: { agent, notAfter: certNotAfter.toString(), ver: 1, sig: signature },
        asset: '0x2::sui::SUI',
        apis: APIS,
        _warning: 'DEMO ONLY — contains an agent PRIVATE KEY in plaintext. Do not commit or reuse in production; mint agent keys in a KMS/secure enclave instead. The binding cert auto-expires.',
      };
      setOut(JSON.stringify(config, null, 2));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <Button onClick={generate} disabled={busy}>{busy ? 'Signing…' : 'Export x402 agent config'}</Button>
      {err && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '6px 0 0' }}>✗ {err}</p>}
      {out && (
        <div style={{ marginTop: 8 }}>
          <p style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 4px', fontWeight: 600 }}>
            ⚠ DEMO ONLY — this contains the agent’s private key in plaintext. Don’t commit or reuse it in production; mint agent keys in a KMS/enclave. The cert auto-expires (≤30 days).
          </p>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 4px' }}>
            Save as <code>sdk/scripts/.x402-testnet.json</code>, then <code>npm run isub:claude:testnet</code>. Your wallet signed the binding, so the agent pays THIS mandate → charges show up here.
          </p>
          <textarea
            readOnly
            value={out}
            onFocus={(e) => e.currentTarget.select()}
            rows={12}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 11, background: 'var(--surface-2)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
          />
        </div>
      )}
    </div>
  );
}

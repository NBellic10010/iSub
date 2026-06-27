// Managed thin-client ↔ gateway contract — DETERMINISTIC (MockChain, no live chain). Pins that
// `@isubpay/sdk/client` (IsubServiceClient) actually cooperates with `IsubGateway` across BOTH
// PAYG wiring shapes, end to end over real HTTP. This is the gap agent-auth-http-redteam left:
// that red-team drives the door with RAW fetch, never the thin client a merchant actually ships.
//
// Why this exists: the secure-by-default change (gateway tenant resolves to agentAuth:'enforce'
// when unset) silently 403'd the proofless thin-client `use()` — the documented managed flow.
// These assertions lock the resolved contract so that regression can't return unnoticed:
//   1. trusted tenant (agentAuthMode:'off') + use()        no proof   → 200   (self-metering)
//   2. secure-by-default tenant (mode unset) + use()       no proof   → 403   (bearer door closed)
//   3. enforce tenant + use(proof)                         valid PoP  → 200   (agent via shared key)
//   4. enforce tenant + use()                              no proof   → 403   (thin client surfaces it)
//   5. trusted tenant (off) + useMetered(items)           no proof   → 200   (RateCard-priced)
//   6. enforce tenant + useMetered(items, proof)          valid PoP  → 200   (metered + PoP)
//
// Run: `npm run managed-thinclient:smoke` (sets --experimental-sqlite for node:sqlite).
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubGateway, type MerchantRouting } from '../src/gateway';
import { IsubServiceClient } from '../src/client-sdk';
import { openDb } from '../src/db';
import { registerMerchant } from '../src/sql-store';
import { issueAgentCert, signCall, payloadOf, type CallProof } from '../src/agent-auth';
import { ChargeMode, MandateStatus } from '../src/constants';
import type { BillerChain } from '../src/biller';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';
import type { RateCard } from '../src/pricing';

const PAYOUT = '0x5e7711ce'; // shared merchant payout (== mandate.merchant) across all test tenants
const AMOUNT = 30n;
const subscriberKp = Ed25519Keypair.generate();
const agentKp = Ed25519Keypair.generate();

// 10 MIST/call → useMetered([{calls,3}]) = 30 MIST, well within the mandate's 1000 budget.
const RATE_CARD: RateCard = { version: 1, meters: { calls: { key: 'calls', priceNum: 10n, priceDen: 1n, units: 1n } } };

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}

class MockChain implements BillerChain {
  m: MandateState = {
    id: 'M1', accountId: 'accM1', subscriber: subscriberKp.toSuiAddress(), merchant: PAYOUT, planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n, rateCap: 100_000n, rateWindowMs: 60_000n,
    windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: PAYOUT, spentTotal: 0n, totalBudget: 1_000n, expiryMs: 4_000_000_000_000n,
    chargeSeq: 0n, refundedTotal: 0n, maxPerCharge: 100_000n, notBeforeMs: 0n, status: MandateStatus.Active,
  };
  async getMandate(id: string): Promise<MandateState> { if (id !== 'M1') throw new Error('no mandate ' + id); return { ...this.m }; }
  async getAccount(id: string): Promise<AccountState> { return { id, owner: subscriberKp.toSuiAddress(), balance: 1_000_000n }; }
  async chargeMetered(): Promise<{ digest: string }> { return { digest: 'd1' }; } // not exercised (no flush in-test)
}

const keeperSigner: IsubSigner = { address: PAYOUT, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };

/** Stand up a one-tenant gateway and return a thin client bound to it (+ a stopper). */
async function tenant(apiKey: string, routing: MerchantRouting): Promise<{ client: IsubServiceClient; stop: () => Promise<void> }> {
  const db = openDb(':memory:');
  registerMerchant(db, { id: 'acme', name: 'Acme', apiKey, payoutAddress: PAYOUT });
  const gateway = new IsubGateway({
    chain: new MockChain(),
    keeperSigner,
    db,
    policy: { windowMs: 999_999_000 }, // huge → no auto-flush; we only test the ingest/report gate
    routing: (mid) => (mid === 'acme' ? routing : null),
  });
  const server = gateway.listen(0);
  const port = await new Promise<number>((r) => server.on('listening', () => r((server.address() as AddressInfo).port)));
  const client = new IsubServiceClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey });
  return { client, stop: async () => { await gateway.stop(); } };
}

/** A fresh, valid agent PoP for one call (cert by the subscriber + per-call signature by the agent). */
async function proofFor(usageId: string, payload: string): Promise<CallProof> {
  const cert = await issueAgentCert(subscriberKp, { mandateId: 'M1', agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 });
  const notAfter = BigInt(Date.now()) + 60_000n;
  const { sig } = await signCall(agentKp, { mandateId: 'M1', usageId, merchant: PAYOUT, payload, notAfter });
  return { sig, notAfter, cert };
}

async function main(): Promise<void> {
  // 1 — trusted merchant backend self-metering (the managed-e2e shape): proofless use() → 200.
  console.log('\n• tenant agentAuthMode:off — thin client use() with NO proof');
  {
    const { client, stop } = await tenant('sk_off', { payoutAddress: PAYOUT, agentAuthMode: 'off' });
    const r = await client.use('M1', AMOUNT, 'off-1');
    check(r.status === 200 && r.ok, 'use() no proof on off tenant → 200 served (trusted self-metering)');
    await stop();
  }

  // 2 — secure-by-default tenant (mode unset → 'enforce'): proofless use() → 403 (the regression guard).
  console.log('\n• tenant with NO agentAuthMode (secure-by-default) — thin client use() with NO proof');
  {
    const { client, stop } = await tenant('sk_default', { payoutAddress: PAYOUT });
    const r = await client.use('M1', AMOUNT, 'def-1');
    check(r.status === 403, 'use() no proof on default tenant → 403 (bearer-mandateId door closed)');
    await stop();
  }

  // 3 — enforce tenant + a real agent PoP through the thin client → 200.
  console.log('\n• tenant agentAuthMode:enforce — thin client use(proof) with a valid PoP');
  {
    const { client, stop } = await tenant('sk_enforce', { payoutAddress: PAYOUT, agentAuthMode: 'enforce' });
    const proof = await proofFor('enf-1', payloadOf(undefined, AMOUNT));
    const r = await client.use('M1', AMOUNT, 'enf-1', proof);
    check(r.status === 200 && r.ok, 'use(proof) on enforce tenant → 200 served (agent via shared api-key)');
    // and the same tenant rejects a proofless call (the thin client surfaces the 403 verbatim)
    const bad = await client.use('M1', AMOUNT, 'enf-2');
    check(bad.status === 403, 'use() no proof on enforce tenant → 403 (thin client surfaces the gate)');
    await stop();
  }

  // 5 — trusted tenant with a RateCard: useMetered() prices raw qty, no proof → 200.
  console.log('\n• tenant agentAuthMode:off + rateCard — thin client useMetered() with NO proof');
  {
    const { client, stop } = await tenant('sk_off_metered', { payoutAddress: PAYOUT, agentAuthMode: 'off', rateCard: RATE_CARD });
    const r = await client.useMetered('M1', [{ meterKey: 'calls', qty: 3n }], 'm-off-1');
    check(r.status === 200 && r.ok, 'useMetered() no proof on off tenant → 200 (RateCard-priced)');
    await stop();
  }

  // 6 — enforce tenant with a RateCard: useMetered(proof) with a PoP bound to the item payload → 200.
  console.log('\n• tenant agentAuthMode:enforce + rateCard — thin client useMetered(proof)');
  {
    const { client, stop } = await tenant('sk_enf_metered', { payoutAddress: PAYOUT, agentAuthMode: 'enforce', rateCard: RATE_CARD });
    const items = [{ meterKey: 'calls', qty: 3n }];
    const proof = await proofFor('m-enf-1', payloadOf(items));
    const r = await client.useMetered('M1', items, 'm-enf-1', proof);
    check(r.status === 200 && r.ok, 'useMetered(proof) on enforce tenant → 200 (metered + PoP through thin client)');
    await stop();
  }

  console.log(`\n✅ managed thin-client smoke passed — ${checks} assertions (thin client ↔ gateway: off 200 · default 403 · enforce+PoP 200 · enforce-bare 403 · metered-off 200 · metered+PoP 200).`);
  process.exit(0); // per-tenant service window loops would otherwise keep the event loop alive
}

main().catch((e) => {
  console.error('\n❌ managed thin-client smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

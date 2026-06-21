// Agent-auth HTTP red-team — proves the proof-of-possession gate is wired through the GATEWAY's
// HTTP door, not just the MCP tool path (the adversarial-review B2 gap). Real IsubGateway over real
// HTTP, MockChain, agentAuth: 'enforce'. A bearer POST /usage (mandate id only) → 403; a properly
// signed call → 200; a forged cert (not signed by the subscriber) → 403.
//
// Run: `npm run agent-auth-http:redteam` (sets --experimental-sqlite for node:sqlite).
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubGateway } from '../src/gateway';
import { openDb } from '../src/db';
import { registerMerchant } from '../src/sql-store';
import { issueAgentCert, signCall, payloadOf } from '../src/agent-auth';
import { ChargeMode, MandateStatus } from '../src/constants';
import type { BillerChain } from '../src/biller';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';

const PAYOUT = '0x5e7711ce'; // merchant payout address (== mandate.merchant)
const API_KEY = 'sk_http_redteam';
const AMOUNT = 30n;
const subscriberKp = Ed25519Keypair.generate();
const agentKp = Ed25519Keypair.generate();
const attackerKp = Ed25519Keypair.generate();

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

async function main(): Promise<void> {
  const db = openDb(':memory:');
  registerMerchant(db, { id: 'acme', name: 'Acme', apiKey: API_KEY, payoutAddress: PAYOUT });
  const gateway = new IsubGateway({
    chain: new MockChain(),
    keeperSigner,
    db,
    policy: { windowMs: 999_999_000, agentAuth: 'enforce' }, // ENFORCE on the managed gateway
    routing: (mid) => (mid === 'acme' ? { payoutAddress: PAYOUT } : null),
  });
  const server = gateway.listen(0);
  const port = await new Promise<number>((r) => server.on('listening', () => r((server.address() as AddressInfo).port)));
  const base = `http://127.0.0.1:${port}`;
  console.log(`• managed gateway (enforce) listening ${base}`);

  const postUsage = async (body: Record<string, unknown>): Promise<{ status: number; data: any }> => {
    const r = await fetch(`${base}/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-isub-api-key': API_KEY, 'x-isub-mandate': 'M1' },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };

  const notAfter = (): bigint => BigInt(Date.now()) + 60_000n;
  const cert = await issueAgentCert(subscriberKp, { mandateId: 'M1', agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 });
  const certArg = { agent: cert.agent, notAfter: cert.notAfter.toString(), ver: cert.ver, sig: cert.sig };

  console.log('\n• LEGIT signed call over HTTP');
  const na = notAfter();
  const { sig } = await signCall(agentKp, { mandateId: 'M1', usageId: 'legit-1', merchant: PAYOUT, payload: payloadOf(undefined, AMOUNT), notAfter: na });
  const legit = await postUsage({ amount: AMOUNT.toString(), usageId: 'legit-1', agentSig: sig, agentSigNotAfter: Number(na), agentCert: certArg });
  check(legit.status === 200 && legit.data.ok === true, 'POST /usage with valid cert + per-call signature → 200 served');

  console.log('\n• BEARER call over HTTP — only the public mandate id, no proof');
  const bearer = await postUsage({ amount: AMOUNT.toString(), usageId: 'bearer-1' });
  check(bearer.status === 403, 'POST /usage with mandate id ONLY → 403 (bearer door CLOSED over HTTP)');

  console.log('\n• FORGED cert — signed by the attacker, not the subscriber');
  const na2 = notAfter();
  const forged = await issueAgentCert(attackerKp, { mandateId: 'M1', agent: attackerKp.toSuiAddress(), notAfter: 0n, ver: 1 });
  const { sig: aSig } = await signCall(attackerKp, { mandateId: 'M1', usageId: 'forge-1', merchant: PAYOUT, payload: payloadOf(undefined, AMOUNT), notAfter: na2 });
  const forge = await postUsage({
    amount: AMOUNT.toString(), usageId: 'forge-1', agentSig: aSig, agentSigNotAfter: Number(na2),
    agentCert: { agent: forged.agent, notAfter: forged.notAfter.toString(), ver: forged.ver, sig: forged.sig },
  });
  check(forge.status === 403, 'attacker-signed cert (not the subscriber) → 403');

  server.close();
  console.log(`\n✅ agent-auth HTTP red-team passed — ${checks} assertions (gateway HTTP door: legit 200 · bearer 403 · forged-cert 403).`);
  process.exit(0); // the per-tenant service window loop keeps the event loop alive
}

main().catch((e) => {
  console.error('\n❌ HTTP red-team failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

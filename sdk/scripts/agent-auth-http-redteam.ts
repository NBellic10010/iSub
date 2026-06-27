// Agent-auth HTTP red-team — proves the proof-of-possession gate is wired through the GATEWAY's
// HTTP door, not just the MCP tool path (the adversarial-review B2 gap). Real IsubGateway over real
// HTTP, MockChain, agentAuth: 'enforce'. A bearer POST /usage (mandate id only) → 403; a properly
// signed call → 200; a forged cert (not signed by the subscriber) → 403.
//
// Run: `npm run agent-auth-http:redteam` (sets --experimental-sqlite for node:sqlite).
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubGateway } from '../src/gateway';
import { IsubService } from '../src/service';
import { openDb } from '../src/db';
import { registerMerchant } from '../src/sql-store';
import { issueAgentCert, signCall, payloadOf } from '../src/agent-auth';
import { ChargeMode, MandateStatus } from '../src/constants';
import { memBillerStore, type BillerChain } from '../src/biller';
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

  // ===== SECURE BY DEFAULT — gateway policy WITHOUT agentAuth + tenant WITHOUT agentAuthMode ⇒ enforce =====
  // The gateway above set agentAuth:'enforce' explicitly. This pins that OMITTING it everywhere (neither
  // gateway policy nor tenant routing sets a mode) still resolves to 'enforce', so a forgetful operator's
  // managed gateway does NOT ship the bearer-mandateId hole open. Regression guard for secure-by-default.
  console.log('\n• SECURE-BY-DEFAULT: gateway with NO agentAuth configured anywhere');
  const db2 = openDb(':memory:');
  registerMerchant(db2, { id: 'acme', name: 'Acme', apiKey: API_KEY, payoutAddress: PAYOUT });
  const gw2 = new IsubGateway({
    chain: new MockChain(),
    keeperSigner,
    db: db2,
    policy: { windowMs: 999_999_000 }, // NO agentAuth set
    routing: (mid) => (mid === 'acme' ? { payoutAddress: PAYOUT } : null), // NO agentAuthMode set
  });
  const srv2 = gw2.listen(0);
  const port2 = await new Promise<number>((r) => srv2.on('listening', () => r((srv2.address() as AddressInfo).port)));
  const bearer2 = await fetch(`http://127.0.0.1:${port2}/usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-isub-api-key': API_KEY, 'x-isub-mandate': 'M1' },
    body: JSON.stringify({ amount: AMOUNT.toString(), usageId: 'bearer-default-1' }),
  });
  check(bearer2.status === 403, 'gateway with NO agentAuth anywhere: bearer → 403 (secure by default, not off)');
  srv2.close();

  // ===== GATEWAY human opt-out — the documented escape hatch still serves (pins the behavior change) =====
  console.log('\n• GATEWAY human opt-out: tenant agentAuthMode=off → bearer still 200');
  const db3 = openDb(':memory:');
  registerMerchant(db3, { id: 'human', name: 'HumanCo', apiKey: 'sk_human', payoutAddress: PAYOUT });
  const gw3 = new IsubGateway({
    chain: new MockChain(),
    keeperSigner,
    db: db3,
    policy: { windowMs: 999_999_000 },
    routing: (mid) => (mid === 'human' ? { payoutAddress: PAYOUT, agentAuthMode: 'off' } : null),
  });
  const srv3 = gw3.listen(0);
  const port3 = await new Promise<number>((r) => srv3.on('listening', () => r((srv3.address() as AddressInfo).port)));
  const human = await fetch(`http://127.0.0.1:${port3}/usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-isub-api-key': 'sk_human', 'x-isub-mandate': 'M1' },
    body: JSON.stringify({ amount: AMOUNT.toString(), usageId: 'human-1' }),
  });
  check(human.status === 200, 'gateway tenant agentAuthMode=off → bearer api-key call still 200 (human opt-out intact)');
  srv3.close();

  // ===== IsubService.listen() — the PRIMITIVE's own HTTP door is secure by default too =====
  // (Residual hole the first secure-by-default fix MISSED: listen() called use() with no authMode →
  //  inherited the permissive service 'off'. The re-audit reproduced a bearer→200; this pins the fix.)
  console.log('\n• SERVICE.listen() door — bearer → 403 by default; PoP → 200; explicit off → 200');
  const svcDoor = new IsubService(new MockChain(), keeperSigner, PAYOUT, memBillerStore(), { windowMs: 999_999_000 }); // NO agentAuth
  const sd = svcDoor.listen(0);
  const sdPort = await new Promise<number>((r) => sd.on('listening', () => r((sd.address() as AddressInfo).port)));
  const postUse = (port: number, body: Record<string, unknown>): Promise<{ status: number }> =>
    fetch(`http://127.0.0.1:${port}/use`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-isub-mandate': 'M1' }, body: JSON.stringify(body) });
  const sdBearer = await postUse(sdPort, { amount: AMOUNT.toString(), usageId: 'sd-bearer' });
  check(sdBearer.status === 403, 'service.listen() bearer (no PoP) → 403 (secure by default — primitive door now fixed)');
  const naSd = BigInt(Date.now()) + 60_000n;
  const certSd = await issueAgentCert(subscriberKp, { mandateId: 'M1', agent: agentKp.toSuiAddress(), notAfter: 0n, ver: 1 });
  const { sig: sdSig } = await signCall(agentKp, { mandateId: 'M1', usageId: 'sd-ok', merchant: PAYOUT, payload: payloadOf(undefined, AMOUNT), notAfter: naSd });
  const sdOk = await postUse(sdPort, { amount: AMOUNT.toString(), usageId: 'sd-ok', agentSig: sdSig, agentSigNotAfter: Number(naSd), agentCert: { agent: agentKp.toSuiAddress(), notAfter: '0', ver: 1, sig: certSd.sig } });
  check(sdOk.status === 200, 'service.listen() valid PoP → 200 served');
  sd.close();
  const svcOff = new IsubService(new MockChain(), keeperSigner, PAYOUT, memBillerStore(), { windowMs: 999_999_000 });
  const sd2 = svcOff.listen(0, { authMode: 'off' }); // explicit human opt-out
  const sd2Port = await new Promise<number>((r) => sd2.on('listening', () => r((sd2.address() as AddressInfo).port)));
  const sd2Bearer = await postUse(sd2Port, { amount: AMOUNT.toString(), usageId: 'sd-off' });
  check(sd2Bearer.status === 200, 'service.listen({authMode:off}) → bearer 200 (explicit human opt-out)');
  sd2.close();

  console.log(`\n✅ agent-auth HTTP red-team passed — ${checks} assertions (gateway + service.listen HTTP doors: legit 200 · bearer 403 · forged-cert 403 · secure-by-default 403 · human opt-out 200).`);
  process.exit(0); // the per-tenant service window loop keeps the event loop alive
}

main().catch((e) => {
  console.error('\n❌ HTTP red-team failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

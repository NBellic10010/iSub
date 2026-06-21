// Managed e2e — the acceptance test for "接入即用、不 self-host". A "merchant backend"
// uses ONLY @isub/sdk/client (api-key + use + verifyWebhook) against a running IsubGateway;
// an agent subscribes; the gateway (iSub keeper key) settles on the REAL chain; funds land
// in the merchant's payout address. The merchant section touches NO IsubService / biller /
// DB / chain / charge-signing — that's the whole point.
//
// Run: `npm run managed-e2e:testnet` (real chain) or `npm run managed-e2e` (localnet).
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IsubClient, keypairSigner, ChargeMode } from '../src/index';
import { IsubAgent } from '../src/agent';
import { IsubGateway } from '../src/gateway';
import { IsubServiceClient, verifyWebhook } from '../src/client-sdk';
import { openDb } from '../src/db';
import { registerMerchant } from '../src/sql-store';
import { clientFor, actor, suiBalance, loadDeployment, fmt, explorer, NETWORK } from './env';

const SUI = 1_000_000_000n;
const USE = SUI / 100n; // 0.01 SUI per metered call
const BUDGET = 5n * USE; // 0.05 SUI lifetime
const DEPOSIT = 8n * USE; // 0.08 SUI funded
const WINDOW_MS = 3_600_000; // huge → settle only on our manual flush (deterministic)
const API_KEY = 'sk_managed_e2e';
const WH_SECRET = 'whsec_managed_e2e';

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}
function eqBig(a: bigint, b: bigint, label: string): void {
  check(a === b, `${label} — ${fmt(a)} == ${fmt(b)}`);
}
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b));
  });

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const ex = explorer();
  console.log(`• network: ${NETWORK} ｜ package ${packageId}`);

  const [subKp, merchantKp, keeperKp] = await Promise.all([
    actor(client, 'subscriber'),
    actor(client, 'merchant'),
    actor(client, 'keeper'),
  ]);
  const subscriber = keypairSigner(subKp, client); // the agent's key (funds the account, authorizes)
  const merchant = keypairSigner(merchantKp, client); // payout recipient + plan creator (signs ONCE)
  const keeperSigner = keypairSigner(keeperKp, client); // iSub gateway's keeper key (signs charges)

  // ---- iSub operator side: DB + webhook receiver + the gateway ----
  const db = openDb(':memory:');
  registerMerchant(db, { id: 'acme', name: 'Acme Cloud', apiKey: API_KEY, payoutAddress: merchant.address });

  const webhooks: { type: string; verified: boolean }[] = [];
  const receiver = createServer(async (req, res) => {
    const body = await readBody(req);
    const sig = req.headers['isub-signature'];
    const verified = typeof sig === 'string' && verifyWebhook({ secret: WH_SECRET, body, signatureHeader: sig });
    webhooks.push({ type: (JSON.parse(body) as { type: string }).type, verified });
    res.statusCode = verified ? 200 : 401;
    res.end();
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const recvPort = (receiver.address() as AddressInfo).port;

  const gateway = new IsubGateway({
    chain: isub,
    keeperSigner,
    db,
    policy: { windowMs: WINDOW_MS },
    routing: (mid) => (mid === 'acme' ? { payoutAddress: merchant.address, webhook: { url: `http://127.0.0.1:${recvPort}`, secret: WH_SECRET } } : null),
  });
  const gwPort = await new Promise<number>((r) => {
    const s = gateway.listen(0);
    s.on('listening', () => r((s.address() as AddressInfo).port));
  });
  const gwUrl = `http://127.0.0.1:${gwPort}`;
  console.log(`• gateway listening ${gwUrl} ｜ webhook receiver :${recvPort}`);

  // ---- merchant setup: create a PAYG plan whose keeper = iSub's gateway keeper (signs ONCE) ----
  console.log('\n• merchant 建 PAYG plan(keeper = iSub gateway keeper)');
  const { planId } = await isub.createPlanPayg(merchant, { rateCap: BUDGET, rateWindowMs: BigInt(WINDOW_MS), keeper: keeperSigner.address });

  // ---- agent: fund + autonomously subscribe (one signature, real on-chain mandate) ----
  console.log('• agent 开户 + 充值 + 自主订阅');
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  const agent = new IsubAgent(isub, subscriber, {
    accountId,
    allowed: [{ name: 'gpu-api', planId, merchant: merchant.address, mode: ChargeMode.Payg, rateCap: BUDGET, rateWindowMs: BigInt(WINDOW_MS), keeper: keeperSigner.address, maxTotalBudget: BUDGET, maxPerCharge: BUDGET }],
  });
  const sub = await agent.subscribe({ service: 'gpu-api', budget: BUDGET });
  check(sub.ok && !!sub.mandateId, `agent.subscribe ok (mandate ${sub.mandateId?.slice(0, 12)}…)`);
  const mandateId = sub.mandateId!;

  // ================= MERCHANT BACKEND — uses ONLY the thin client =================
  // No IsubClient / IsubService / biller / DB / signer here. Just api-key over HTTP.
  const backend = new IsubServiceClient({ baseUrl: gwUrl, apiKey: API_KEY });

  console.log('\n• 商家后端(仅瘦 client)记 3 笔用量');
  for (let i = 0; i < 3; i++) {
    const r = await backend.use(mandateId, USE, `u${i}`);
    check(r.status === 200, `backend.use #${i + 1} → 200 served`);
  }
  const st = await backend.status(mandateId);
  check(st?.serviceable === true, 'backend.status → serviceable');
  // ================================================================================

  console.log('• gateway 后台结算(iSub keeper 签)→ 真链扣款');
  const merchBefore = await suiBalance(client, merchant.address);
  const fr = await gateway.flush(API_KEY, mandateId);
  console.log('  flush:', JSON.stringify(fr, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const m = await isub.getMandate(mandateId);
  eqBig(m.spentTotal, 3n * USE, 'on-chain spent = 3×use');
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - 3n * USE, 'agent account debited 3×use');
  eqBig((await suiBalance(client, merchant.address)) - merchBefore, 3n * USE, 'merchant payout received 3×use');

  // a brief beat so the fire-and-forget webhook delivers
  await new Promise((r) => setTimeout(r, 1500));
  check(webhooks.some((w) => w.type === 'charge.succeeded' && w.verified), 'merchant got a SIGNED charge.succeeded webhook (verifyWebhook passed)');

  console.log('\n• 预算用尽 → 瘦 client 收到 402(无链调用)');
  // use the remaining 2×budget worth, flush, then one more should be gated
  for (let i = 3; i < 5; i++) check((await backend.use(mandateId, USE, `u${i}`)).status === 200, `backend.use #${i + 1} served`);
  await gateway.flush(API_KEY, mandateId);
  const gated = await backend.use(mandateId, USE, 'u5');
  check(gated.status === 402, 'over-budget backend.use → 402 gated');

  await gateway.stop();
  receiver.close();
  console.log(`\n✅ managed e2e passed — ${checks} assertions on ${NETWORK}`);
  console.log('  商家后端全程只用 @isub/sdk/client(api-key + use + verifyWebhook)—— 零 IsubService/biller/DB/签名');
  console.log(`• explorer  mandate ${ex.object(mandateId)}`);
}

main().catch((e) => {
  console.error('\n❌ managed e2e failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

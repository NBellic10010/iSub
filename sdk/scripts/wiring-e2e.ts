// Phase 2.1 打通 — the end-to-end proof on a REAL network. Ties the two halves
// together for the first time and runs the biller against the real chain:
//
//   merchant 建 PAYG plan → agent.subscribe(真 Mandate) → 带凭证 service.use ×N
//   → service.flush → 真 charge_metered 扣款 → 断言用量对账/不超额/seq/gate/撤销即停
//
// Run: `npm run wiring:e2e` (localnet) or `npm run wiring-e2e:testnet`.
import { IsubClient, keypairSigner, ChargeMode, abortCodeOf, errorName } from '../src/index';
import { IsubAgent } from '../src/agent';
import { IsubService } from '../src/service';
import { memBillerStore } from '../src/biller';
import { clientFor, actor, suiBalance, loadDeployment, fmt, explorer, NETWORK } from './env';

const SUI = 1_000_000_000n;
const USE = SUI / 100n; // 0.01 SUI per call (metered)
const BUDGET = 5n * USE; // 0.05 SUI lifetime → exactly 5 calls' worth
const DEPOSIT = 8n * USE; // 0.08 SUI funded (covers the 0.05 charged + buffer)
const RATE_CAP = BUDGET; // big enough that a batch settles in one window
const WINDOW_MS = 60_000n;

let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}
function eqBig(a: bigint, b: bigint, label: string): void {
  check(a === b, `${label} — ${fmt(a)} == ${fmt(b)}`);
}
async function expectAbort(p: Promise<unknown>, code: number, label: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const got = abortCodeOf(e);
    check(got === code, `${label} → aborts ${errorName(code)} (#${code})${got === code ? '' : ` [got #${got}]`}`);
    return;
  }
  throw new Error(`✗ ${label}: expected abort #${code} but it succeeded`);
}

async function main(): Promise<void> {
  const client = clientFor();
  const { packageId } = loadDeployment();
  const isub = new IsubClient({ client, packageId });
  const ex = explorer();
  console.log(`• network: ${NETWORK} ｜ package ${packageId}`);

  const [subKp, merchantKp, keeperKp] = await Promise.all([actor(client, 'subscriber'), actor(client, 'merchant'), actor(client, 'keeper')]);
  const subscriber = keypairSigner(subKp, client); // the agent's key = the funded account's owner
  const merchant = keypairSigner(merchantKp, client); // payee: creates the plan, only RECEIVES
  const keeper = keypairSigner(keeperKp, client); // the service's operational charger (signs + pays gas)

  console.log('\n• merchant 建 PAYG plan(keeper = 独立运营 key)');
  const { planId } = await isub.createPlanPayg(merchant, { rateCap: RATE_CAP, rateWindowMs: WINDOW_MS, keeper: keeper.address });

  console.log('• agent 开户 + 充值 + 自主订阅(authorize_metered,真链)');
  const { accountId } = await isub.openAccount(subscriber);
  await isub.deposit(subscriber, { accountId, amount: DEPOSIT });
  const agent = new IsubAgent(isub, subscriber, {
    accountId,
    allowed: [
      {
        name: 'gpu-api',
        planId,
        merchant: merchant.address,
        mode: ChargeMode.Payg,
        rateCap: RATE_CAP,
        rateWindowMs: WINDOW_MS,
        keeper: keeper.address,
        maxTotalBudget: BUDGET,
        maxPerCharge: BUDGET,
      },
    ],
  });
  const sub = await agent.subscribe({ service: 'gpu-api', budget: BUDGET });
  check(sub.ok && !!sub.mandateId, `agent.subscribe ok (mandate ${sub.mandateId?.slice(0, 12)}…)`);
  const mandateId = sub.mandateId!;

  // The service runtime: charges with the KEEPER key (pays gas), pays the merchant.
  // Manual flush for deterministic assertions.
  const service = new IsubService(isub, keeper, merchant.address, memBillerStore(), { windowMs: Number(WINDOW_MS) });

  console.log('\n• agent 带凭证调服务 ×3,服务计量');
  for (let i = 0; i < 3; i++) {
    const r = await service.use(mandateId, USE, `u${i}`);
    check(r.status === 200, `use #${i + 1} served (200)`);
  }

  console.log('• service.flush → 真 charge_metered 扣款');
  const merchBefore = await suiBalance(client, merchant.address);
  await service.flush(mandateId);
  let m = await isub.getMandate(mandateId);
  eqBig(m.spentTotal, 3n * USE, 'on-chain spent = 3×use');
  check(m.chargeSeq === 1n, 'one batched charge (seq=1)');
  eqBig((await isub.getAccount(accountId)).balance, DEPOSIT - 3n * USE, 'account debited by 3×use');
  eqBig((await suiBalance(client, merchant.address)) - merchBefore, 3n * USE, 'merchant received 3×use');

  console.log('\n• 再用 ×2 → flush(到预算上限)');
  for (let i = 3; i < 5; i++) check((await service.use(mandateId, USE, `u${i}`)).status === 200, `use #${i + 1} served`);
  await service.flush(mandateId);
  m = await isub.getMandate(mandateId);
  eqBig(m.spentTotal, BUDGET, 'spent = budget (5×use)');
  check(m.chargeSeq === 2n, 'second batched charge (seq=2)');

  console.log('\n• 预算用尽 → gate 拒服(无链调用)');
  const gated = await service.use(mandateId, USE, 'u5');
  check(gated.status === 402 && gated.reason === 'insufficient remaining budget for this request', 'over-budget request gated → 402');

  console.log('\n• agent 撤销 → 链上扣不动');
  await agent.unsubscribe(mandateId);
  check((await isub.getMandate(mandateId)).status === 2, 'mandate Revoked on-chain'); // 2 = Revoked
  await expectAbort(isub.chargeMetered(keeper, { accountId, mandateId, amount: USE, seq: 2n }), 4, 'post-revoke charge');

  console.log(`\n✅ wiring e2e passed — ${checks} assertions on ${NETWORK}（agent → service → 真链扣款 全链路打通）`);
  console.log(`• explorer  mandate ${ex.object(mandateId)}`);
}

main().catch((e) => {
  console.error('\n❌ wiring e2e failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

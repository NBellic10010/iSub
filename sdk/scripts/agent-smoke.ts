// Agent e2e: an autonomous agent, inside a human-set SpendPolicy, subscribes to a paid
// (PAYG, "per-call tool") service, the service meters + charges, the agent's own per-charge
// cap is enforced, it checks its budget, then auto-unsubscribes — and a post-cancel charge
// is rejected on-chain. This is the headline "agent buys services within a budget" demo,
// running on a real network through the same SDK.
//
// Run: `npm run agent:smoke` (localnet) or `npm run agent-smoke:testnet`.
import { IsubClient, keypairSigner, errorName, abortCodeOf, ChargeMode } from '../src/index';
import { IsubAgent, type SpendPolicy } from '../src/agent';
import { clientFor, actor, suiBalance, loadDeployment, fmt, explorer, NETWORK } from './env';

const LOCAL = NETWORK === 'localnet';
const SUI = 1_000_000_000n;
const ALLOWANCE = (3n * SUI) / 10n; // 0.3 SUI — the human's monthly allowance to the agent's account
const RATE_CAP = SUI / 10n; // 0.10 SUI per window (merchant's plan)
const WINDOW_MS = LOCAL ? 2_000n : 12_000n;
const SVC_BUDGET = SUI / 5n; // 0.20 SUI — the agent authorizes this on the subscription
const MAX_PER_CHARGE = SUI / 20n; // 0.05 SUI — the agent's OWN per-charge throttle
const USE = (3n * SUI) / 100n; // 0.03 SUI — one metered "tool call"

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
  try { await p; } catch (e) {
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

  console.log('• funding actors (agent / service-merchant / service-keeper)…');
  const [agentKp, merchantKp, keeperKp] = await Promise.all([
    actor(client, 'subscriber'), // reuse the persistent "subscriber" key as the agent's account owner
    actor(client, 'merchant'),
    actor(client, 'keeper'),
  ]);
  const agentSigner = keypairSigner(agentKp, client); // the agent's session key (owns its dedicated Account)
  const merchant = keypairSigner(merchantKp, client); // the paid service
  const keeper = keypairSigner(keeperKp, client); // the service's charger

  // Human side: open the agent's dedicated Account + fund it with the allowance (= hard cap).
  console.log('\n• human funds the agent account (allowance = hard cap)');
  const { accountId } = await isub.openAccount(agentSigner);
  await isub.deposit(agentSigner, { accountId, amount: ALLOWANCE });

  // The paid "tool" service publishes a PAYG plan.
  console.log('• service publishes a paid (PAYG) plan');
  const { planId } = await isub.createPlanPayg(merchant, { rateCap: RATE_CAP, rateWindowMs: WINDOW_MS, keeper: keeper.address });

  // Human writes the agent's SpendPolicy (model A): one allow-listed service, with caps.
  const policy: SpendPolicy = {
    accountId,
    allowed: [{
      name: 'price-feed',
      planId,
      merchant: merchant.address,
      mode: ChargeMode.Payg,
      rateCap: RATE_CAP,
      rateWindowMs: WINDOW_MS,
      keeper: keeper.address,
      maxTotalBudget: SVC_BUDGET,
      maxPerCharge: MAX_PER_CHARGE,
    }],
  };
  const agent = new IsubAgent(isub, agentSigner, policy);

  console.log('\n• agent inspects what it may subscribe to');
  const services = agent.listServices();
  check(services.length === 1 && services[0]!.name === 'price-feed', 'agent sees exactly its allow-listed service');

  console.log('\n• agent autonomously subscribes (within policy)');
  const sub = await agent.subscribe({ service: 'price-feed', budget: SVC_BUDGET });
  check(sub.ok && !!sub.mandateId && sub.terms === 'approved', `subscribe ok, terms=approved (mandate ${sub.mandateId?.slice(0, 10)}…)`);
  const mandateId = sub.mandateId!;
  eqBig((await isub.getAccount(accountId)).balance, ALLOWANCE, 'subscribe moved no funds (authorize is not pre-funding)');

  console.log('\n• [negative] agent cannot subscribe to a non-allow-listed service');
  const bad = await agent.subscribe({ service: '0xdeadbeef', budget: SVC_BUDGET });
  check(!bad.ok && /not in the agent/.test(bad.reason ?? ''), 'open discovery is OFF → unknown service rejected by the policy');

  console.log('\n• service meters a tool call and charges (keeper)');
  const merchBefore = await suiBalance(client, merchant.address);
  await isub.chargeMetered(keeper, { accountId, mandateId, amount: USE, seq: 0n });
  eqBig((await isub.getAccount(accountId)).balance, ALLOWANCE - USE, 'account debited by the metered amount');
  eqBig((await suiBalance(client, merchant.address)) - merchBefore, USE, 'service received the charge');

  console.log('\n• [negative] a single charge over the agent’s max_per_charge is rejected on-chain');
  await expectAbort(isub.chargeMetered(keeper, { accountId, mandateId, amount: MAX_PER_CHARGE + 1n, seq: 1n }), 24, 'over-max_per_charge');

  console.log('\n• agent checks its budget');
  const status = await agent.budgetStatus();
  eqBig(status.balance, ALLOWANCE - USE, 'budget_status balance correct');
  check(status.subscriptions.length === 1, 'budget_status lists the active subscription');

  console.log('\n• agent task done → auto-unsubscribe');
  const un = await agent.unsubscribe(mandateId);
  check(un.ok, 'unsubscribe ok');
  check((await isub.getMandate(mandateId)).status === 2, 'mandate is Revoked on-chain');

  console.log('\n• [negative] charge after unsubscribe is rejected');
  await expectAbort(isub.chargeMetered(keeper, { accountId, mandateId, amount: USE, seq: 1n }), 4, 'post-unsubscribe charge');

  console.log(`\n✅ agent smoke passed — ${checks} assertions on ${NETWORK}`);
  console.log(`• explorer  mandate ${ex.object(mandateId)}`);
}

main().catch((e) => {
  console.error('\n❌ agent smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

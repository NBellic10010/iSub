// x402 EXACT smoke — iSub ACCEPTING the STANDARD x402 V2 `exact` scheme end-to-end: SELLER builds an
// `exact` 402 → FACILITATOR SIMULATES the buyer's signed transfer (rejecting anything that doesn't pay
// the merchant exactly) → SETTLES it by executing the buyer's own bytes (FINAL, real on-chain digest).
// Adversarial: underpay / overpay / wrong merchant / wrong asset / failed simulation / scheme+network
// mismatch are all rejected. Deterministic — a mock Sui client returns canned simulate/execute results,
// so no chain is needed. Run: npx tsx scripts/x402-exact-smoke.ts
import { Buffer } from 'node:buffer';
import {
  buildExactRequirements,
  paymentRequired,
  ExactFacilitator,
  EXACT_SCHEME,
  encodePayment,
  decodePayment,
  type ExactChainClient,
  type ExactPaymentPayload,
} from '../src/x402';

const MERCHANT = '0x000000000000000000000000000000000000000000000000000000000000a11ce';
const PAYER = '0x000000000000000000000000000000000000000000000000000000000000b0b0b0';
const ASSET = '0x2::sui::SUI';
const NET = 'sui-testnet' as const;

let checks = 0;
const check = (c: boolean, label: string): void => {
  if (!c) throw new Error('✗ ' + label);
  checks++;
  console.log('  ✓ ' + label);
};

/** A mock Sui client: simulate() returns a configurable balance-change set; execute() returns a digest. */
function mockClient(opts: {
  simSuccess?: boolean;
  credits?: { coinType: string; address: string; amount: string }[];
  sender?: string;
  execSuccess?: boolean;
  digest?: string;
}): ExactChainClient {
  return {
    async simulateTransaction() {
      const tx = { status: { success: opts.simSuccess ?? true }, balanceChanges: opts.credits ?? [], transaction: { sender: opts.sender } };
      return opts.simSuccess === false
        ? { $kind: 'FailedTransaction' as const, FailedTransaction: tx }
        : { $kind: 'Transaction' as const, Transaction: tx };
    },
    async executeTransaction() {
      const tx = { digest: opts.digest ?? '0xDIGEST', status: { success: opts.execSuccess ?? true } };
      return opts.execSuccess === false
        ? { $kind: 'FailedTransaction' as const, FailedTransaction: tx }
        : { $kind: 'Transaction' as const, Transaction: tx };
    },
  };
}

/** A buyer X-PAYMENT envelope — the tx bytes are opaque to the facilitator's logic (the mock decides). */
function pay(over: Partial<ExactPaymentPayload> = {}): ExactPaymentPayload {
  return {
    x402Version: 2,
    scheme: EXACT_SCHEME,
    network: NET,
    payload: { transaction: Buffer.from('txbytes').toString('base64'), signature: 'AAAA' },
    ...over,
  };
}

async function main(): Promise<void> {
  // SELLER
  const req = buildExactRequirements({ amount: 1_000_000n, payTo: MERCHANT, asset: ASSET, network: NET, resource: '/api/data' });
  check(req.scheme === EXACT_SCHEME, 'seller builds an exact 402 challenge');
  check(paymentRequired([req]).accepts[0]?.maxAmountRequired === '1000000', '402 carries the exact amount');

  // X-PAYMENT header codec round-trips an exact payload
  const decoded = decodePayment<ExactPaymentPayload>(encodePayment(pay()));
  check(decoded.scheme === EXACT_SCHEME && !!decoded.payload.transaction, 'X-PAYMENT codec round-trips an exact payload');

  // HAPPY PATH — exact credit to the merchant → verify true, settle FINAL with a real digest
  const good = new ExactFacilitator(mockClient({ credits: [{ coinType: ASSET, address: MERCHANT, amount: '1000000' }], sender: PAYER, digest: '0xFEED' }), NET);
  const v = await good.verify(pay(), req);
  check(v.isValid && v.payer === PAYER, 'verify accepts an exact, correctly-addressed payment (payer recovered)');
  const s = await good.settle(pay(), req);
  check(s.success && s.settlement === 'final' && s.txHash === '0xFEED', 'settle executes the buyer tx → FINAL on-chain digest');

  // ADVERSARIAL — verify rejects everything that isn't an exact payment to the merchant
  const under = new ExactFacilitator(mockClient({ credits: [{ coinType: ASSET, address: MERCHANT, amount: '999999' }] }), NET);
  check((await under.verify(pay(), req)).invalidReason === 'amount_mismatch', 'rejects underpayment (amount_mismatch)');
  const over = new ExactFacilitator(mockClient({ credits: [{ coinType: ASSET, address: MERCHANT, amount: '1000001' }] }), NET);
  check((await over.verify(pay(), req)).invalidReason === 'amount_mismatch', 'rejects overpayment (exact means exact)');
  const wrongTo = new ExactFacilitator(mockClient({ credits: [{ coinType: ASSET, address: PAYER, amount: '1000000' }] }), NET);
  check((await wrongTo.verify(pay(), req)).invalidReason === 'no_payment_to_merchant', 'rejects payment to the wrong address');
  const wrongAsset = new ExactFacilitator(mockClient({ credits: [{ coinType: '0x2::foo::FOO', address: MERCHANT, amount: '1000000' }] }), NET);
  check((await wrongAsset.verify(pay(), req)).invalidReason === 'no_payment_to_merchant', 'rejects payment in the wrong asset');
  const simFail = new ExactFacilitator(mockClient({ simSuccess: false, credits: [{ coinType: ASSET, address: MERCHANT, amount: '1000000' }] }), NET);
  check((await simFail.verify(pay(), req)).invalidReason === 'simulation_failed', 'rejects a transfer that fails simulation');

  // SCHEME / NETWORK guards
  const f = new ExactFacilitator(mockClient({ credits: [{ coinType: ASSET, address: MERCHANT, amount: '1000000' }] }), NET);
  check((await f.verify(pay({ scheme: 'mandate' }), req)).invalidReason === 'scheme_mismatch', 'rejects a non-exact scheme');
  check((await f.verify(pay({ network: 'sui-mainnet' }), req)).invalidReason === 'network_mismatch', 'rejects a network mismatch');

  // SETTLE surfaces an on-chain execution failure
  const execFail = new ExactFacilitator(mockClient({ execSuccess: false }), NET);
  check(!(await execFail.settle(pay(), req)).success, 'settle surfaces an on-chain execution failure');

  console.log(`\nx402 exact: ${checks} checks passed ✓`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

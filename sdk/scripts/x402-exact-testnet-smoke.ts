// x402 EXACT — REAL testnet settlement (no mock). A buyer actor signs a real SUI transfer to a
// merchant via `createExactPayment()`; `ExactFacilitator` SIMULATES it (asserting it pays the merchant
// exactly) then EXECUTES it on Sui testnet, returning the real on-chain digest. Proves "iSub accepts
// the STANDARD x402 `exact` scheme" on-chain — the interop claim, settled for real, not just in a mock.
//
// Uses dedicated `.secrets/testnet/x402-exact-{buyer,merchant}.key` actors (gitignored) — never your
// main wallet. Costs a little testnet SUI (0.01 + gas). The buyer is faucet-funded on demand, with a
// clear "fund from your wallet" fallback if the gated testnet faucet rate-limits.
// Run: npm run x402-exact-testnet:smoke   (sets ISUB_NETWORK=testnet)
import { clientFor, actor, loadOrCreateActor, suiBalance, explorer, NETWORK, fmt } from './env';
import { buildExactRequirements, createExactPayment, ExactFacilitator, type PaymentRequirements } from '../src/x402';

const ASSET = '0x2::sui::SUI';
const AMOUNT = 10_000_000n; // 0.01 SUI — the exact price the merchant charges
const X402_NET = 'sui-testnet' as const;

let checks = 0;
const check = (c: boolean, label: string): void => { if (!c) throw new Error('✗ ' + label); checks++; console.log('  ✓ ' + label); };

async function main(): Promise<void> {
  if (NETWORK !== 'testnet') throw new Error(`run with ISUB_NETWORK=testnet (got "${NETWORK}")`);
  const client = clientFor();
  // buyer pays the price + gas; merchant only receives (no gas → no funding needed).
  const buyer = await actor(client, 'x402-exact-buyer', 'testnet', AMOUNT + 60_000_000n);
  const merchant = loadOrCreateActor('x402-exact-merchant', 'testnet');
  const ex = explorer('testnet');
  console.log(`• buyer    ${buyer.toSuiAddress()}`);
  console.log(`• merchant ${merchant.toSuiAddress()}`);

  // SELLER — a standard `exact` 402 for 0.01 SUI to the merchant.
  const req: PaymentRequirements = buildExactRequirements({
    amount: AMOUNT, payTo: merchant.toSuiAddress(), asset: ASSET, network: X402_NET, resource: '/api/data',
  });
  check(req.scheme === 'exact', 'seller built a standard exact 402 challenge');

  // BUYER — sign a REAL transfer with its own key (nothing iSub-specific; any x402 client could do this).
  const payment = await createExactPayment({ requirements: req, signer: buyer, client });
  check(!!payment.payload.transaction && !!payment.payload.signature, 'buyer signed a real on-chain transfer (createExactPayment)');

  // FACILITATOR — simulate (verify), then execute (settle) on testnet.
  const fac = new ExactFacilitator(client, X402_NET);
  const v = await fac.verify(payment, req);
  check(v.isValid && v.payer === buyer.toSuiAddress(), 'facilitator verify SIMULATED the tx → pays merchant exactly (payer = buyer)');

  const before = await suiBalance(client, merchant.toSuiAddress());
  console.log('• settling on testnet (executes the buyer\'s signed transfer)…');
  const s = await fac.settle(payment, req);
  check(s.success && s.settlement === 'final' && !!s.txHash, 'facilitator settle EXECUTED on testnet → FINAL digest');
  console.log(`  digest:   ${s.txHash}`);
  console.log(`  explorer: ${ex.tx(s.txHash!)}`);

  // Confirm on-chain: the merchant received EXACTLY the requested amount.
  await client.waitForTransaction({ digest: s.txHash! });
  const after = await suiBalance(client, merchant.toSuiAddress());
  check(after - before === AMOUNT, `merchant received EXACTLY ${fmt(AMOUNT)} on-chain (Δ ${fmt(after - before)})`);

  console.log(`\n✅ testnet x402 EXACT verified — ${checks} assertions. Real settlement: ${ex.tx(s.txHash!)}`);
  process.exit(0); // gRPC handles can keep the loop alive; exit cleanly
}

main().catch((e) => { console.error('\n❌ x402 exact testnet smoke failed:', e instanceof Error ? e.message : e); process.exit(1); });

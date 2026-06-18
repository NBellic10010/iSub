// One-off connectivity + shape probe for the Sui testnet gRPC endpoint.
// Confirms: (1) SuiGrpcClient connects over gRPC-web, (2) the user's wallet is
// reachable/funded, (3) the real shape of getBalance() and getObject(json) on
// gRPC (the README warns the json shape may differ from JSON-RPC).
//
// Run: npx tsx scripts/grpc-probe.ts
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

const TESTNET_GRPC = 'https://fullnode.testnet.sui.io:443';
const USER_WALLET = '0x5c2b3348b8d952cac541e01755bcfa9f562cbb6fd098287c11658ae9724692fe';

async function main(): Promise<void> {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: TESTNET_GRPC });

  console.log('• getReferenceGasPrice()');
  const gas = await client.getReferenceGasPrice();
  console.log('  →', JSON.stringify(gas));

  console.log('\n• getBalance(userWallet) — confirm shape + funding');
  const bal = await client.getBalance({ owner: USER_WALLET });
  console.log('  →', JSON.stringify(bal, null, 2));

  console.log('\n• getObject(0x6 clock, include:{json,content})');
  const obj = await client.getObject({
    objectId: SUI_CLOCK_OBJECT_ID,
    include: { json: true },
  });
  console.log('  type →', obj.object.type);
  console.log('  json →', JSON.stringify(obj.object.json));

  console.log('\n✅ gRPC testnet reachable');
}

main().catch((e) => {
  console.error('\n❌ probe failed:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});

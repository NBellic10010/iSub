// Programmatic publish of the iSub Move package, over gRPC.
// Compiles via the Sui CLI (bytecode dump), then publishes with a network actor
// and records the package id in isub.<network>.json.
//   localnet: ephemeral, re-run after each --force-regenesis.
//   testnet:  persistent — publishes ONCE; pass --force to republish.
//
// Run: `npm run publish:localnet`  or  `npm run publish:testnet`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import { clientFor, actor, saveDeployment, baseUrlFor, deploymentPath, explorer, NETWORK, type Deployment } from './env';

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(here, '..', '..', 'contracts');

interface Compiled {
  modules: string[];
  dependencies: string[];
  digest: number[];
}

function compile(): Compiled {
  const out = execFileSync('sui', ['move', 'build', '--dump-bytecode-as-base64'], {
    cwd: CONTRACTS,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as Compiled;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  if (NETWORK !== 'localnet' && existsSync(deploymentPath()) && !force) {
    console.log(`• ${NETWORK} already deployed (${deploymentPath()}). Pass --force to republish.`);
    return;
  }

  const client = clientFor();
  console.log(`• network: ${NETWORK}`);

  console.log('• compiling contracts…');
  const { modules, dependencies } = compile();
  console.log(`  ${modules.length} module(s), ${dependencies.length} dependencies`);

  console.log('• funding publisher…');
  const publisher = await actor(client, 'publisher', NETWORK, MIST_PER_SUI / 5n); // 0.2 SUI floor for a publish
  console.log(`  publisher ${publisher.toSuiAddress()}`);

  const tx = new Transaction();
  tx.setSenderIfNotSet(publisher.toSuiAddress());
  const upgradeCap = tx.publish({ modules, dependencies });
  tx.transferObjects([upgradeCap], publisher.toSuiAddress());

  console.log('• publishing…');
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer: publisher, include: { effects: true } });
  const t = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  if (res.$kind !== 'Transaction' || !t.status.success) {
    throw new Error(`publish failed: ${JSON.stringify(t.status.error ?? res.$kind)}`);
  }
  await client.waitForTransaction({ digest: t.digest });

  // The published package shows up as a changed object with outputState 'PackageWrite'.
  const pkg = (t.effects?.changedObjects ?? []).find((c) => c.outputState === 'PackageWrite');
  if (!pkg) throw new Error('publish produced no PackageWrite change');

  const deployment: Deployment = { packageId: pkg.objectId, network: NETWORK, baseUrl: baseUrlFor() };
  saveDeployment(deployment);

  const ex = explorer();
  console.log(`\n✓ published`);
  console.log(`  package   ${deployment.packageId}`);
  console.log(`  digest    ${t.digest}`);
  console.log(`  explorer  ${ex.object(deployment.packageId)}`);
  console.log(`  saved →   isub.${NETWORK}.json`);
}

main().catch((e) => {
  console.error('\n✗ publish failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

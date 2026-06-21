// Mock-chain wiring for the "Claude pays via x402" demo — self-contained (no testnet funds).
// Builds a MockChain mandate + agent key + cert + an enforce-mode IsubService, then delegates the
// seller + MCP tools to the shared buildAgentServer (same code path the testnet setup uses; only the
// chain + `confirm`/`getMandate` differ). For real on-chain settlement see x402-testnet-agent-setup.ts.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { IsubService } from '../src/service';
import { memBillerStore, type BillerChain } from '../src/biller';
import { issueAgentCert } from '../src/agent-auth';
import { MandateFacilitator } from '../src/x402';
import { buildAgentServer, type PaidApi, type AgentServer } from './x402-agent-core';
import { ChargeMode, MandateStatus } from '../src/constants';
import { IsubAbortError } from '../src/errors';
import type { IsubSigner } from '../src/signer';
import type { MandateState, AccountState } from '../src/types';

const ASSET = '0xdemo::usdc::USDC'; // demo asset label (USDC stand-in)
const MANDATE_ID = 'M_demo';

const APIS: PaidApi[] = [
  { path: '/weather', price: 1_000n, label: 'Weather forecast (per call)', run: () => ({ location: 'Tokyo, JP', tempC: 26, forecast: 'humid & warm' }) },
  { path: '/premium-quote', price: 5_000n, label: 'Premium stock quote (per call)', run: () => ({ ticker: 'NVDA', price: 1234.5, source: 'demo-feed' }) },
];

function mk(id: string, subscriber: string, merchant: string): MandateState {
  return {
    id, accountId: 'acc_' + id, subscriber, merchant, planId: '0xplan',
    mode: ChargeMode.Payg, price: 0n, intervalMs: 0n, lastChargedMs: 0n,
    rateCap: 1_000_000n, rateWindowMs: 3_600_000n, windowStartMs: 0n, windowSpent: 0n, authorizedKeeper: merchant,
    spentTotal: 0n, totalBudget: 100_000n, expiryMs: 4_000_000_000_000n, chargeSeq: 0n, refundedTotal: 0n,
    maxPerCharge: 1_000_000n, notBeforeMs: 0n, status: MandateStatus.Active,
  };
}

class MockChain implements BillerChain {
  mandates = new Map<string, MandateState>();
  add(m: MandateState): void { this.mandates.set(m.id, m); }
  async getMandate(id: string): Promise<MandateState> {
    const m = this.mandates.get(id);
    if (!m) throw new Error('no mandate ' + id);
    return { ...m };
  }
  async getAccount(id: string): Promise<AccountState> { return { id, owner: '0xowner', balance: 1_000_000n }; }
  async chargeMetered(_s: IsubSigner, p: { accountId: string; mandateId: string; amount: bigint; seq: bigint }): Promise<{ digest: string }> {
    const m = this.mandates.get(p.mandateId)!;
    if (p.seq !== m.chargeSeq) throw new IsubAbortError(20);
    if (m.spentTotal + p.amount > m.totalBudget) throw new IsubAbortError(9);
    m.spentTotal += p.amount;
    m.chargeSeq += 1n;
    return { digest: 'mock-d' + m.chargeSeq };
  }
}

export interface MockAgent extends AgentServer {
  mandateId: string;
  agentAddress: string;
  subscriberAddress: string;
  log: (...a: unknown[]) => void;
}

export async function setupX402Demo(): Promise<MockAgent> {
  const subKp = new Ed25519Keypair();
  const agentKp = new Ed25519Keypair();
  const merchantKp = new Ed25519Keypair();
  const merchantAddr = merchantKp.toSuiAddress();

  const chain = new MockChain();
  chain.add(mk(MANDATE_ID, subKp.toSuiAddress(), merchantAddr));

  const signer: IsubSigner = { address: merchantAddr, signAndExecute: async () => ({ digest: '', success: true, abortCode: null, events: [], createdIds: [] }) };
  const service = new IsubService(chain, signer, merchantAddr, memBillerStore(), { windowMs: 3_600_000, agentAuth: 'enforce' });
  const facilitator = new MandateFacilitator(service, 'sui-localnet');
  // F2: bounded cert lifetime (30d), never 0/forever — consistent with the testnet ceremony + web export.
  const cert = await issueAgentCert(subKp, { mandateId: MANDATE_ID, agent: agentKp.toSuiAddress(), notAfter: BigInt(Date.now() + 30 * 24 * 60 * 60 * 1000), ver: 1 });
  const log = (...a: unknown[]): void => console.error('[isub-x402]', ...a);

  const srv = buildAgentServer({
    facilitator,
    mandateId: MANDATE_ID,
    agentKp,
    cert,
    payoutAddress: merchantAddr,
    asset: ASSET,
    network: 'sui-localnet',
    apis: APIS,
    log,
    confirm: async (id) => { const fr = await service.flush(id); return { digest: fr.find((r) => r.digest)?.digest }; },
    getMandate: async (id) => { const m = await chain.getMandate(id); return { spentTotal: m.spentTotal, totalBudget: m.totalBudget }; },
  });

  return { ...srv, mandateId: MANDATE_ID, agentAddress: agentKp.toSuiAddress(), subscriberAddress: subKp.toSuiAddress(), log };
}

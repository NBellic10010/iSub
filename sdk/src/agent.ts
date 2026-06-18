// `./agent` — the agent-runtime surface for autonomous, budget-bounded subscriptions.
//
// A human configures a `SpendPolicy`: a dedicated funded Account (its balance = a HARD
// spend ceiling) plus an allow-list of pre-approved services. The agent then subscribes /
// uses / unsubscribes on its own, but only WITHIN that policy. Two trust models:
//   A (default) — allow-list: the agent may only subscribe to services the human approved.
//       The `expected_*` terms come from the human-approved entry, so on-chain terms-binding
//       (F-05/F-06) stays meaningful: a swapped/changed plan aborts.
//   B (opt-in `allowOpen`) — open discovery: the agent may subscribe to any plan, bounded
//       ONLY by the budget envelope (account balance + per-mandate caps). Honest caveat:
//       terms-binding can't protect this (no human reviewed the terms) — the cap is the guard.
//
// Framework-agnostic + dependency-free: exposes verbs (functions) and JSON-schema tool
// descriptors that map 1:1 onto MCP tools / LangChain tools / OpenAI functions. The MCP
// server binding is a thin adapter the host wires (register each `AgentTool`), so this
// module pulls no MCP SDK and stays isomorphic.
import { ChargeMode } from './constants';
import type { IsubClient } from './client';
import type { IsubSigner } from './signer';
import { accountExposure } from './exposure';

/**
 * A service the human pre-approved the agent to subscribe to (model A). The terms here
 * are exactly what the human reviewed — used as the `expected_*` echo at authorize, so
 * terms-binding asserts the on-chain plan still matches what was approved.
 */
export interface AllowedService {
  /** Human-facing label the agent reasons about, e.g. "real-time price feed". */
  name: string;
  planId: string;
  /** Expected payout recipient (bound at authorize). */
  merchant: string;
  mode: ChargeMode;
  // Fixed terms (required when mode === Fixed)
  price?: bigint;
  intervalMs?: bigint;
  // PAYG terms (required when mode === Payg)
  rateCap?: bigint;
  rateWindowMs?: bigint;
  /** PAYG authorized keeper (bound at authorize). */
  keeper?: string;
  /** The agent may authorize at most this much on a single subscription to this service. */
  maxTotalBudget: bigint;
  /** PAYG per-charge ceiling (defaults to rateCap if omitted). */
  maxPerCharge?: bigint;
}

export interface SpendPolicy {
  /** The agent's dedicated Account — the human funds it with the agent's allowance (= hard cap). */
  accountId: string;
  /** Model A: services the human pre-approved. */
  allowed: AllowedService[];
  /** Model B (opt-in): allow subscribing to plans NOT in `allowed`, bounded only by the envelope. */
  allowOpen?: boolean;
  /** Default subscription lifetime if the agent doesn't specify one (ms). Default 30 days. */
  defaultTtlMs?: number;
}

export interface SubscribeResult {
  ok: boolean;
  mandateId?: string;
  service?: string;
  mode?: 'fixed' | 'payg';
  /** 'approved' (allow-list, terms-bound) | 'unverified-open' (model B, envelope-only). */
  terms?: 'approved' | 'unverified-open';
  reason?: string;
}

export interface BudgetStatus {
  balance: bigint;
  totalAuthorized: bigint;
  atRisk: bigint;
  overAuthorized: boolean;
  subscriptions: { mandateId: string; merchant: string; remaining: bigint }[];
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Wraps an `IsubClient` + the agent's signer + a `SpendPolicy`. The verbs are what an
 * agent calls (directly or via the MCP/LangChain tools from `agentTools`).
 */
export class IsubAgent {
  private readonly watched = new Map<string, AllowedService>(); // mandateId → the service it subscribed to

  constructor(
    private readonly isub: IsubClient,
    private readonly signer: IsubSigner,
    private readonly policy: SpendPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  /** Services the agent is allowed to subscribe to (model A). */
  listServices(): { name: string; planId: string; mode: 'fixed' | 'payg'; maxTotalBudget: bigint }[] {
    return this.policy.allowed.map((s) => ({
      name: s.name,
      planId: s.planId,
      mode: s.mode === ChargeMode.Fixed ? 'fixed' : 'payg',
      maxTotalBudget: s.maxTotalBudget,
    }));
  }

  /** Subscribe to a service by name or planId, authorizing up to `budget` for `ttlMs`. */
  async subscribe(args: { service: string; budget: bigint; ttlMs?: number }): Promise<SubscribeResult> {
    if (args.budget <= 0n) return { ok: false, reason: 'budget must be positive' };

    const approved = this.policy.allowed.find((s) => s.planId === args.service || s.name === args.service);
    let entry: AllowedService;
    let terms: 'approved' | 'unverified-open';
    if (approved) {
      entry = approved;
      terms = 'approved';
      if (args.budget > entry.maxTotalBudget) {
        return { ok: false, reason: `budget exceeds the human-approved cap for "${entry.name}" (${entry.maxTotalBudget})` };
      }
    } else if (this.policy.allowOpen) {
      entry = await this.resolveOpen(args.service, args.budget); // model B — terms from the plan, NOT human-reviewed
      terms = 'unverified-open';
    } else {
      return { ok: false, reason: `"${args.service}" is not in the agent's allowed services (open discovery disabled)` };
    }

    const expiryMs = BigInt(this.now() + (args.ttlMs ?? this.policy.defaultTtlMs ?? DEFAULT_TTL_MS));
    try {
      let mandateId: string;
      if (entry.mode === ChargeMode.Fixed) {
        ({ mandateId } = await this.isub.authorizeFixed(this.signer, {
          accountId: this.policy.accountId,
          planId: entry.planId,
          expectedPrice: entry.price!,
          expectedIntervalMs: entry.intervalMs!,
          expectedMerchant: entry.merchant,
          totalBudget: args.budget,
          expiryMs,
        }));
      } else {
        ({ mandateId } = await this.isub.authorizeMetered(this.signer, {
          accountId: this.policy.accountId,
          planId: entry.planId,
          expectedRateCap: entry.rateCap!,
          expectedRateWindowMs: entry.rateWindowMs!,
          expectedMerchant: entry.merchant,
          expectedKeeper: entry.keeper!,
          totalBudget: args.budget,
          expiryMs,
          maxPerCharge: entry.maxPerCharge ?? entry.rateCap!,
        }));
      }
      this.watched.set(mandateId, entry);
      return { ok: true, mandateId, service: entry.name, mode: entry.mode === ChargeMode.Fixed ? 'fixed' : 'payg', terms };
    } catch (e) {
      // e.g. ETermsMismatch (plan changed/swapped since approval) or EPlanInactive — surface, don't crash.
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Cancel a subscription (terminal). The agent calls this when its task is done. */
  async unsubscribe(mandateId: string): Promise<{ ok: boolean; digest?: string; reason?: string }> {
    try {
      const { digest } = await this.isub.revoke(this.signer, { mandateId });
      this.watched.delete(mandateId);
      return { ok: true, digest };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Current spend posture: balance vs total still-authorizable across this agent's subscriptions. */
  async budgetStatus(extraMandateIds: string[] = []): Promise<BudgetStatus> {
    const ids = [...new Set([...this.watched.keys(), ...extraMandateIds])];
    const e = await accountExposure(this.isub, this.policy.accountId, ids);
    return {
      balance: e.balance,
      totalAuthorized: e.totalAuthorized,
      atRisk: e.atRisk,
      overAuthorized: e.overAuthorized,
      subscriptions: e.byMandate.map((m) => ({ mandateId: m.mandateId, merchant: m.merchant, remaining: m.remaining })),
    };
  }

  private async resolveOpen(planId: string, budget: bigint): Promise<AllowedService> {
    const p = await this.isub.quoteFromPlan(planId); // for display/derivation only — NOT human-reviewed
    return {
      name: `open:${planId.slice(0, 10)}…`,
      planId,
      merchant: p.merchant,
      mode: p.mode,
      price: p.price,
      intervalMs: p.intervalMs,
      rateCap: p.rateCap,
      rateWindowMs: p.rateWindowMs,
      keeper: p.keeper,
      maxTotalBudget: budget, // model B: only the account envelope caps it
      maxPerCharge: p.rateCap,
    };
  }
}

// ===== framework-agnostic tool descriptors (map 1:1 to MCP / LangChain / OpenAI fn) =====

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Build the agent's payment tools over an `IsubAgent`. Register each on your MCP server
 * (name/description/inputSchema/handler line up with MCP's tool shape), or adapt to a
 * LangChain/OpenAI tool. Amounts cross the LLM boundary as decimal STRINGS (bigint-safe).
 */
export function agentTools(agent: IsubAgent): AgentTool[] {
  return [
    {
      name: 'list_services',
      description: 'List the services this agent is allowed to subscribe to, with each one’s spending cap.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () =>
        agent.listServices().map((s) => ({ ...s, maxTotalBudget: s.maxTotalBudget.toString() })),
    },
    {
      name: 'subscribe',
      description:
        'Subscribe to a service (by name or plan id) within a budget. Charges are pulled automatically within the cap; cancel with unsubscribe when done.',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name or plan id (must be in list_services unless open discovery is enabled).' },
          budget: { type: 'string', description: 'Max total to authorize for this subscription, in base units (decimal string).' },
          ttlMs: { type: 'number', description: 'Optional subscription lifetime in ms; defaults to the policy default.' },
        },
        required: ['service', 'budget'],
        additionalProperties: false,
      },
      handler: async (a) => agent.subscribe({ service: String(a.service), budget: BigInt(String(a.budget)), ttlMs: a.ttlMs as number | undefined }),
    },
    {
      name: 'unsubscribe',
      description: 'Cancel a subscription by mandate id (terminal — stops all future charges immediately).',
      inputSchema: {
        type: 'object',
        properties: { mandateId: { type: 'string', description: 'The mandate id returned by subscribe.' } },
        required: ['mandateId'],
        additionalProperties: false,
      },
      handler: async (a) => agent.unsubscribe(String(a.mandateId)),
    },
    {
      name: 'budget_status',
      description: 'Report remaining budget: account balance, total still-authorized across subscriptions, and what is at risk.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const s = await agent.budgetStatus();
        return {
          balance: s.balance.toString(),
          totalAuthorized: s.totalAuthorized.toString(),
          atRisk: s.atRisk.toString(),
          overAuthorized: s.overAuthorized,
          subscriptions: s.subscriptions.map((x) => ({ ...x, remaining: x.remaining.toString() })),
        };
      },
    },
  ];
}

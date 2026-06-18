import type { Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SuiClientTypes } from '@mysten/sui/client';

/** The transaction effects/events we always request, so created ids + abort status are available. */
export const EXEC_INCLUDE = { effects: true, events: true } as const;
type ExecResult = SuiClientTypes.TransactionResult<typeof EXEC_INCLUDE>;

/**
 * Normalized outcome of executing one transaction — deliberately transport- and
 * wallet-agnostic. The signer seam returns THIS, not a raw gRPC response, so the
 * client/keeper never import gRPC generics and a future browser-wallet signer can
 * conform by producing the same shape.
 */
export interface IsubExecResult {
  digest: string;
  success: boolean;
  /** Move abort code if the tx failed with a MoveAbort, else null. */
  abortCode: number | null;
  /** Emitted events: fully-qualified type + parsed JSON fields. */
  events: { type: string; json: Record<string, unknown> | null }[];
  /** Object ids created by this tx (effects.changedObjects, idOperation 'Created'). */
  createdIds: string[];
}

/**
 * The signing seam — iSub's `login()` abstraction.
 *
 * Every state-changing call goes through `IsubSigner.signAndExecute`, so the same
 * client code runs whether the signer is a Node keypair (keeper, smoke, CI), a
 * browser wallet (dApp Kit), or zkLogin/Enoki. Only this interface's impl differs.
 */
export interface IsubSigner {
  /** Sui address that signs and pays gas. */
  readonly address: string;
  signAndExecute(input: { transaction: Transaction }): Promise<IsubExecResult>;
}

/**
 * Normalize a gRPC `TransactionResult` into the transport-agnostic `IsubExecResult`,
 * waiting for fullnode indexing on success. Shared by every signer impl (keypair,
 * browser wallet, zkLogin) so the success/abort/created-id semantics are identical
 * regardless of how the bytes got signed.
 */
export async function normalizeExecResult(res: ExecResult, client: SuiGrpcClient): Promise<IsubExecResult> {
  const t = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction;
  const success = res.$kind === 'Transaction' && t.status.success;
  const abortCode = t.status.success ? null : abortCodeFromError(t.status.error);
  // Read-after-write barrier: ensure the fullnode has indexed it before any read.
  if (success && t.digest) await client.waitForTransaction({ digest: t.digest });
  return {
    digest: t.digest,
    success,
    abortCode,
    events: (t.events ?? []).map((e) => ({ type: e.eventType, json: e.json })),
    createdIds: (t.effects?.changedObjects ?? [])
      .filter((c) => c.idOperation === 'Created')
      .map((c) => c.objectId),
  };
}

/** Recover an abort code from a thrown resolution/dry-run error, or rethrow. */
export function execResultFromThrow(e: unknown): IsubExecResult {
  const code = abortCodeFromMessage(e);
  if (code !== null) return { digest: '', success: false, abortCode: code, events: [], createdIds: [] };
  throw e;
}

/**
 * Node / CLI signer over a gRPC client: wrap a keypair + a `SuiGrpcClient`.
 * Signs, executes, waits for the fullnode to index the tx, and normalizes the
 * result. The browser path (`walletSigner`) implements the same seam.
 */
export function keypairSigner(keypair: Signer, client: SuiGrpcClient): IsubSigner {
  return {
    address: keypair.toSuiAddress(),
    async signAndExecute({ transaction }) {
      let res: ExecResult;
      try {
        res = await client.signAndExecuteTransaction({ transaction, signer: keypair, include: EXEC_INCLUDE });
      } catch (e) {
        // Resolution/dry-run may reject an aborting tx before submit — recover the code.
        return execResultFromThrow(e);
      }
      return normalizeExecResult(res, client);
    },
  };
}

/** gRPC ExecutionError → numeric Move abort code (structured), falling back to the message. */
function abortCodeFromError(error: unknown): number | null {
  if (error && typeof error === 'object') {
    const ma = (error as { MoveAbort?: { abortCode?: string | number } }).MoveAbort;
    if (ma?.abortCode != null) return Number(ma.abortCode);
  }
  return abortCodeFromMessage(error);
}

function abortCodeFromMessage(e: unknown): number | null {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const m = msg.match(/abort code[:\s]+(\d+)/i) ?? msg.match(/MoveAbort\([^,]*,\s*(\d+)\)/);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

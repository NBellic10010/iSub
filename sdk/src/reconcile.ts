// Reconciliation (Phase C): the merchant-side journal vs the chain.
//
// The on-chain `charge_seq` counts every successful charge, so per mandate we can
// answer exactly: did every charge we journaled land, and did anything land that
// we didn't journal (lost response / third-party Fixed trigger)? gRPC has no event
// query, so this journal+counter pair IS the reconciliation path — and it also
// resolves the classic "timed out, did my charge land?" ambiguity.
import type { IsubClient } from './client';
import type { KeeperStore } from './store';

export interface ReconcileRow {
  mandateId: string;
  /** On-chain truth. */
  chainCount: number;
  chainSpent: bigint;
  chainRefunded: bigint;
  /** Local view: charges this keeper journaled + external ones it later observed. */
  journaledCount: number;
  journaledSum: bigint;
  observedCount: number;
  /** chainCount - journaledCount - observedCount. 0 = fully accounted. */
  countDrift: number;
  /** Portion of on-chain spend our own journal can't itemize (externally triggered). */
  unattributedAmount: bigint;
  ok: boolean;
}

export interface ReconcileReport {
  ok: boolean;
  rows: ReconcileRow[];
}

/**
 * Compare the journal in `store` against on-chain state for `mandateIds`
 * (default: every mandate that appears in the journal).
 */
export async function reconcile(
  isub: IsubClient,
  store: KeeperStore,
  mandateIds?: string[],
): Promise<ReconcileReport> {
  const journal = await store.readJournal();
  const ids = mandateIds ?? [...new Set(journal.map((j) => j.mandateId))];

  const rows: ReconcileRow[] = [];
  for (const id of ids) {
    const m = await isub.getMandate(id);
    const mine = journal.filter((j) => j.mandateId === id);
    const journaledCount = mine.filter((j) => j.kind === 'charged').length;
    const journaledSum = mine
      .filter((j) => j.kind === 'charged')
      .reduce((s, j) => s + BigInt(j.amount ?? 0), 0n);
    // Walk the journal with a monotone cursor of "highest chain seq accounted for":
    // my own 'charged' entries advance it by their seq; an 'observed' entry records
    // the absolute chain count at sighting — the gap above the cursor is external.
    let observedCount = 0;
    let accounted = 0;
    for (const j of mine) {
      if (j.kind === 'charged' && j.seq !== undefined) accounted = Math.max(accounted, j.seq);
      if (j.kind === 'observed' && j.seq !== undefined && j.seq > accounted) {
        observedCount += j.seq - accounted;
        accounted = j.seq;
      }
    }
    const chainCount = Number(m.chargeSeq);
    const countDrift = chainCount - journaledCount - observedCount;
    const unattributedAmount = m.spentTotal - journaledSum;
    rows.push({
      mandateId: id,
      chainCount,
      chainSpent: m.spentTotal,
      chainRefunded: m.refundedTotal,
      journaledCount,
      journaledSum,
      observedCount,
      countDrift,
      unattributedAmount,
      ok: countDrift === 0,
    });
  }
  return { ok: rows.every((r) => r.ok), rows };
}

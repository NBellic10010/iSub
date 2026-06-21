// On-chain DISCOVERY of a subscriber's mandates — the piece the relationship index can't get from a
// point-read. The index only knows mandates iSub's own surfaces ingested (checkout, merchant-plans);
// a mandate authorized elsewhere (another device, a script, a stale browser) is on-chain but absent
// from the index, so the subscriber portal can't list it. This recovers the full set from chain.
//
// HOW: gRPC has no historical event query, but the fullnode also serves JSON-RPC at the SAME base URL
// (see scripts/env.ts), and `suix_queryEvents` does. We scan the subscriber's own tx history
// (`{ Sender }` — the subscriber signs their own `authorize*`, so sender == subscriber) and keep the
// `MandateAuthorized` events, which carry the `mandate_id`. Scoped to one address's history, so it
// scales per-subscriber rather than scanning every authorize globally.
//
// CAVEAT: a SPONSORED authorize (gas paid by someone else → sender != subscriber) is NOT a current
// iSub flow and would be missed by the `{ Sender }` filter; revisit (switch to a `MoveEventType`
// scan + `subscriber`-field filter) if sponsored authorize is ever added. We still re-check the
// event's `subscriber` field below so a wrong row can never slip in.
//
// Isomorphic: uses global `fetch` (Node ≥18 / browser), no node:* imports.

export interface DiscoverMandatesOptions {
  /** Fullnode base URL — the one that serves JSON-RPC (same as the gRPC base; e.g.
   *  `https://fullnode.testnet.sui.io:443`). */
  rpcUrl: string;
  /** Published iSub package id — namespaces the `…::subscription::MandateAuthorized` event type. */
  packageId: string;
  /** Subscriber address (0x…). */
  subscriber: string;
  /** Injectable fetch (tests pass a stub); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-page event count (default 50). */
  pageLimit?: number;
  /** Safety cap on pages walked (default 20 → up to 20·pageLimit events). */
  maxPages?: number;
  signal?: AbortSignal;
}

interface RpcEvent {
  type: string;
  sender?: string;
  parsedJson?: Record<string, unknown>;
}
interface QueryEventsPage {
  data?: RpcEvent[];
  nextCursor?: unknown;
  hasNextPage?: boolean;
}

/**
 * Return the ids of every `MandateAuthorized` event the subscriber emitted, newest first, de-duped.
 * Throws if the RPC is unreachable or returns an error — callers treat that as "discovery
 * unavailable" and fall back to whatever the index/local cache already has.
 */
export async function findMandateIdsBySubscriber(opts: DiscoverMandatesOptions): Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const eventType = `${opts.packageId}::subscription::MandateAuthorized`;
  const limit = opts.pageLimit ?? 50;
  const maxPages = opts.maxPages ?? 20;
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: unknown = null;

  for (let page = 0; page < maxPages; page++) {
    const r = await doFetch(opts.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // descending = true → newest mandates first
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_queryEvents', params: [{ Sender: opts.subscriber }, cursor, limit, true] }),
      signal: opts.signal,
    });
    if (!r.ok) throw new Error(`suix_queryEvents → HTTP ${r.status}`);
    const j = (await r.json()) as { result?: QueryEventsPage; error?: { message?: string } };
    if (j.error) throw new Error(`suix_queryEvents: ${j.error.message ?? 'rpc error'}`);
    const result = j.result;
    if (!result) break;

    for (const e of result.data ?? []) {
      if (e.type !== eventType) continue; // the sender's history also holds Charged/Deposited/etc.
      const mid = e.parsedJson?.['mandate_id'];
      const sub = e.parsedJson?.['subscriber'];
      // Defensive: only accept events whose on-chain `subscriber` field is this address.
      if (typeof mid === 'string' && (sub === undefined || sub === opts.subscriber) && !seen.has(mid)) {
        seen.add(mid);
        ids.push(mid);
      }
    }

    if (!result.hasNextPage || result.nextCursor == null) break;
    cursor = result.nextCursor;
  }
  return ids;
}

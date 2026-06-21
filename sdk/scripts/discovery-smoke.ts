// On-chain discovery smoke (pure; no chain — a stub `fetch` returns canned suix_queryEvents pages).
// Proves: only this-subscriber `MandateAuthorized` ids are kept (other event types + other
// subscribers filtered out), cursor pagination is walked, ids are de-duped + newest-first ordered,
// the maxPages cap stops a runaway, the request is shaped right (Sender filter, descending), and
// RPC/HTTP errors throw. Run: npx tsx scripts/discovery-smoke.ts
import { findMandateIdsBySubscriber } from '../src/discovery';

let checks = 0;
const check = (c: boolean, label: string): void => { if (!c) throw new Error('✗ ' + label); checks++; console.log('  ✓ ' + label); };

const PKG = '0xpkg';
const SUB = '0xsub';
const OTHER = '0xother';
const ETYPE = `${PKG}::subscription::MandateAuthorized`;

// Build a stub `fetch` from an array of pages; records the request bodies it saw.
type Page = { data: unknown[]; hasNextPage?: boolean; nextCursor?: unknown; error?: { message: string }; httpStatus?: number };
function stubFetch(pages: Page[]): { fetchImpl: typeof fetch; bodies: any[] } {
  const bodies: any[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init?: any) => {
    bodies.push(JSON.parse(init.body));
    const p = pages[Math.min(i, pages.length - 1)]!;
    i++;
    if (p.httpStatus && p.httpStatus >= 400) return { ok: false, status: p.httpStatus, json: async () => ({}) } as unknown as Response;
    const body = p.error ? { error: p.error } : { result: { data: p.data, hasNextPage: !!p.hasNextPage, nextCursor: p.nextCursor ?? null } };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}
const authd = (mandateId: string, subscriber = SUB) => ({ type: ETYPE, sender: subscriber, parsedJson: { mandate_id: mandateId, subscriber } });

async function main(): Promise<void> {
  // 1) Single page: keep only this-subscriber MandateAuthorized; drop other types + other subscribers.
  {
    const { fetchImpl, bodies } = stubFetch([{ data: [
      authd('0xM1'),
      { type: `${PKG}::subscription::Charged`, parsedJson: { mandate_id: '0xMx' } },     // wrong type
      { type: `${PKG}::subscription::Deposited`, parsedJson: { amount: '5' } },           // wrong type
      authd('0xM2', OTHER),                                                               // wrong subscriber
      authd('0xM3'),
    ] }]);
    const ids = await findMandateIdsBySubscriber({ rpcUrl: 'http://x', packageId: PKG, subscriber: SUB, fetchImpl });
    check(ids.length === 2 && ids[0] === '0xM1' && ids[1] === '0xM3', 'keeps only this subscriber\'s MandateAuthorized ids (drops other types + subscribers)');
    check(!ids.includes('0xM2') && !ids.includes('0xMx'), 'wrong-subscriber and wrong-type events excluded');
    // request shape: Sender filter, descending=true, correct method
    const p = bodies[0];
    check(p.method === 'suix_queryEvents' && p.params[0].Sender === SUB && p.params[3] === true, 'request: suix_queryEvents { Sender } descending');
  }

  // 2) Pagination: walk cursor until hasNextPage=false; collect across pages.
  {
    const { fetchImpl, bodies } = stubFetch([
      { data: [authd('0xA')], hasNextPage: true, nextCursor: { tx: 't1', ev: 0 } },
      { data: [authd('0xB')], hasNextPage: true, nextCursor: { tx: 't2', ev: 0 } },
      { data: [authd('0xC')], hasNextPage: false },
    ]);
    const ids = await findMandateIdsBySubscriber({ rpcUrl: 'http://x', packageId: PKG, subscriber: SUB, fetchImpl });
    check(ids.join(',') === '0xA,0xB,0xC', 'pagination collects across pages in order');
    check(bodies.length === 3, 'stopped after the last page (hasNextPage=false)');
    check(JSON.stringify(bodies[1].params[1]) === JSON.stringify({ tx: 't1', ev: 0 }), 'forwards nextCursor to the next page');
  }

  // 3) De-dup the same mandate_id seen in multiple events.
  {
    const { fetchImpl } = stubFetch([{ data: [authd('0xDUP'), authd('0xDUP'), authd('0xUNIQ')] }]);
    const ids = await findMandateIdsBySubscriber({ rpcUrl: 'http://x', packageId: PKG, subscriber: SUB, fetchImpl });
    check(ids.length === 2 && ids[0] === '0xDUP' && ids[1] === '0xUNIQ', 'de-dups repeated mandate ids');
  }

  // 4) maxPages cap halts a runaway (hasNextPage always true).
  {
    const { fetchImpl, bodies } = stubFetch([{ data: [authd('0xLOOP')], hasNextPage: true, nextCursor: { tx: 'z', ev: 0 } }]);
    const ids = await findMandateIdsBySubscriber({ rpcUrl: 'http://x', packageId: PKG, subscriber: SUB, fetchImpl, maxPages: 3 });
    check(bodies.length === 3, 'maxPages caps the page walk');
    check(ids.length === 1, 'still returns what it found before the cap');
  }

  // 5) RPC error → throws.
  {
    const { fetchImpl } = stubFetch([{ data: [], error: { message: 'boom' } }]);
    let threw = false;
    try { await findMandateIdsBySubscriber({ rpcUrl: 'http://x', packageId: PKG, subscriber: SUB, fetchImpl }); } catch { threw = true; }
    check(threw, 'JSON-RPC error throws');
  }

  // 6) HTTP non-2xx → throws.
  {
    const { fetchImpl } = stubFetch([{ data: [], httpStatus: 503 }]);
    let threw = false;
    try { await findMandateIdsBySubscriber({ rpcUrl: 'http://x', packageId: PKG, subscriber: SUB, fetchImpl }); } catch { threw = true; }
    check(threw, 'HTTP error throws');
  }

  console.log(`\n✓ discovery smoke — ${checks} checks passed`);
}

main().catch((e) => { console.error('\n' + (e instanceof Error ? e.message : e)); process.exit(1); });

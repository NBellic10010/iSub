// Webhook delivery smoke — fully self-contained (a local HTTP server, no chain).
// Asserts: signed delivery verifies server-side; verifyWebhook rejects tampered
// body / wrong secret / stale timestamp; retry recovers a flaky endpoint; a dead
// endpoint dead-letters; enqueue preserves order; keeper events map + stringify bigint.
//
// Run: `npm run webhook:smoke`.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  WebhookDispatcher,
  verifyWebhook,
  signWebhook,
  keeperEventToWebhook,
  type WebhookEvent,
} from '../src/webhook';
import type { KeeperEvent } from '../src/index';

const SECRET = 'whsec_test_0123456789';
let checks = 0;
function check(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`  ✓ ${label}`);
}

const noSleep = (): Promise<void> => Promise.resolve();
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

async function main(): Promise<void> {
  const received: { path: string; verified: boolean; event: WebhookEvent }[] = [];
  const flakyHits = new Map<string, number>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/';
    const body = await readBody(req);
    const sig = req.headers['isub-signature'];
    const verified = typeof sig === 'string' && verifyWebhook({ secret: SECRET, body, signatureHeader: sig });
    received.push({ path, verified, event: JSON.parse(body) as WebhookEvent });

    if (path === '/flaky') {
      const n = (flakyHits.get('x') ?? 0) + 1;
      flakyHits.set('x', n);
      res.statusCode = n === 1 ? 500 : 200; // fail once, then succeed
    } else if (path === '/dead') {
      res.statusCode = 500; // always fail
    } else {
      res.statusCode = verified ? 200 : 401;
    }
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  const evt = (id: string, type = 'charge.succeeded'): WebhookEvent => ({
    id,
    type,
    created: Date.now(),
    data: { mandateId: '0xabc', amount: '50000000' },
  });

  console.log('• signing + server-side verification');
  const good = new WebhookDispatcher({ endpoint: url('/good'), secret: SECRET, sleepImpl: noSleep });
  const r1 = await good.send(evt('evt_1'));
  check(r1.ok && r1.attempts === 1, 'good endpoint delivers first try (200)');
  check(received.at(-1)!.verified, 'server verified the HMAC signature');

  console.log('\n• verifyWebhook negative cases');
  const body = JSON.stringify(evt('evt_v'));
  const ts = Date.now();
  const header = signWebhook(SECRET, body, ts);
  check(verifyWebhook({ secret: SECRET, body, signatureHeader: header }), 'valid signature verifies');
  check(!verifyWebhook({ secret: SECRET, body: body + 'x', signatureHeader: header }), 'tampered body rejected');
  check(!verifyWebhook({ secret: 'wrong', body, signatureHeader: header }), 'wrong secret rejected');
  check(
    !verifyWebhook({ secret: SECRET, body, signatureHeader: header, nowMs: ts + 10 * 60 * 1000 }),
    'stale timestamp rejected (replay window)',
  );

  console.log('\n• retry + dead-letter');
  const flaky = new WebhookDispatcher({ endpoint: url('/flaky'), secret: SECRET, sleepImpl: noSleep });
  const r2 = await flaky.send(evt('evt_2'));
  check(r2.ok && r2.attempts === 2, 'flaky endpoint recovers on retry (500 → 200, 2 attempts)');

  let deadLettered: string | undefined;
  const dead = new WebhookDispatcher({
    endpoint: url('/dead'),
    secret: SECRET,
    maxAttempts: 3,
    sleepImpl: noSleep,
    onDeadLetter: (r) => (deadLettered = r.event.id),
  });
  const r3 = await dead.send(evt('evt_3'));
  check(!r3.ok && r3.attempts === 3, 'dead endpoint fails after maxAttempts');
  check(deadLettered === 'evt_3', 'dead-letter hook fired with the event');

  console.log('\n• ordered delivery via enqueue');
  const ordered = new WebhookDispatcher({ endpoint: url('/order'), secret: SECRET, sleepImpl: noSleep });
  const before = received.length;
  await Promise.all([ordered.enqueue(evt('o1')), ordered.enqueue(evt('o2')), ordered.enqueue(evt('o3'))]);
  const ids = received.slice(before).filter((r) => r.path === '/order').map((r) => r.event.id);
  check(ids.join(',') === 'o1,o2,o3', `enqueue preserves order (got ${ids.join(',')})`);

  console.log('\n• keeper event mapping');
  const ke: KeeperEvent = { type: 'charge.succeeded', mandateId: '0xfeed', at: 1234, amount: 50_000_000n, digest: '0xdig', seq: 3 };
  const mapped = keeperEventToWebhook(ke, 'evt_fixed');
  check(mapped.type === 'charge.succeeded' && mapped.created === 1234, 'keeper event → webhook (type + created)');
  check(mapped.data.amount === '50000000' && typeof mapped.data.amount === 'string', 'bigint amount stringified for JSON');
  check(mapped.data.mandateId === '0xfeed', 'mandateId carried into data');

  server.close();
  console.log(`\n✅ webhook smoke passed — ${checks} assertions`);
}

main().catch((e) => {
  console.error('\n❌ webhook smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

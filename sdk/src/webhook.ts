// Signed webhook delivery — the language-agnostic integration seam. The keeper's
// in-process `onEvent` callback is great for embedding, but a third-party merchant
// (in any language) integrates by receiving SIGNED HTTP webhooks: provision on
// `subscription.active`, gate on `charge.past_due`, deprovision on `mandate.lapsed`.
//
// Server-only (uses node:crypto). Import via `@isub/sdk/webhook`, not the main index.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { KeeperEvent } from './keeper';

/** Wire payload delivered to the merchant endpoint. `data.*` bigints are stringified. */
export interface WebhookEvent {
  id: string;
  type: string;
  /** ms epoch when the underlying event occurred. */
  created: number;
  data: Record<string, unknown>;
}

const SIG_VERSION = 'v1';
const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Sign `${timestamp}.${body}` with HMAC-SHA256. Header value is `t=<ms>,v1=<hex>`
 * (Stripe-style), so the timestamp is authenticated too — defeating replay.
 */
export function signWebhook(secret: string, body: string, timestampMs: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex');
  return `t=${timestampMs},${SIG_VERSION}=${mac}`;
}

export interface VerifyOptions {
  secret: string;
  /** The raw request body, exactly as received (do not re-serialize). */
  body: string;
  /** The `isub-signature` header value. */
  signatureHeader: string;
  /** Reject signatures older than this (replay protection). Default 5 min. */
  toleranceMs?: number;
  nowMs?: number;
}

/**
 * Verify a webhook signature (constant-time) + timestamp freshness. The merchant
 * calls this on their receiver before trusting the event. Returns false on any
 * mismatch, malformed header, or stale timestamp — never throws.
 */
export function verifyWebhook(opts: VerifyOptions): boolean {
  const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const now = opts.nowMs ?? Date.now();
  const fields = new Map<string, string>();
  for (const kv of opts.signatureHeader.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) fields.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  const ts = Number(fields.get('t'));
  const provided = fields.get(SIG_VERSION);
  if (!Number.isFinite(ts) || provided === undefined) return false;
  if (Math.abs(now - ts) > tolerance) return false; // replay / clock skew
  const expected = createHmac('sha256', opts.secret).update(`${ts}.${opts.body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DeliveryResult {
  event: WebhookEvent;
  ok: boolean;
  attempts: number;
  lastStatus?: number;
  error?: string;
}

export interface WebhookDispatcherOptions {
  endpoint: string;
  secret: string;
  /** Total attempts before dead-lettering. Default 5. */
  maxAttempts?: number;
  /** Attempt n waits `baseBackoffMs * 2^(n-1)`. Default 500ms. */
  baseBackoffMs?: number;
  onDeadLetter?: (r: DeliveryResult) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Signs and POSTs webhook events with exponential-backoff retry + a dead-letter
 * hook. `enqueue` serializes deliveries so a slow endpoint can't reorder events or
 * block the keeper tick; `send` delivers one event immediately.
 */
export class WebhookDispatcher {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly opts: WebhookDispatcherOptions) {}

  /** Queue an event for ordered, retried delivery. Resolves with the final result. */
  enqueue(event: WebhookEvent): Promise<DeliveryResult> {
    const next = this.chain.then(() => this.send(event));
    // keep the chain alive regardless of individual outcomes
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Deliver one event now: signed POST, retried up to `maxAttempts`. */
  async send(event: WebhookEvent): Promise<DeliveryResult> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const doSleep = this.opts.sleepImpl ?? sleep;
    const maxAttempts = this.opts.maxAttempts ?? 5;
    const base = this.opts.baseBackoffMs ?? 500;
    const body = JSON.stringify(event);
    let lastStatus: number | undefined;
    let error: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const ts = Date.now();
        const res = await doFetch(this.opts.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'isub-signature': signWebhook(this.opts.secret, body, ts),
            'isub-event-id': event.id,
            'isub-event-type': event.type,
          },
          body,
        });
        lastStatus = res.status;
        if (res.ok) return { event, ok: true, attempts: attempt, lastStatus };
        error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (attempt < maxAttempts) await doSleep(base * 2 ** (attempt - 1));
    }
    const result: DeliveryResult = { event, ok: false, attempts: maxAttempts, lastStatus, error };
    this.opts.onDeadLetter?.(result);
    return result;
  }
}

/**
 * Map any `{ type, at, ...fields }` lifecycle/charge event (keeper OR biller) into a
 * webhook payload — `type`→type, `at`→created, the rest→`data` with bigints stringified.
 */
export function eventToWebhook(e: { type: string; at: number } & Record<string, unknown>, id: string = `evt_${randomUUID()}`): WebhookEvent {
  const { type, at, ...rest } = e;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) data[k] = typeof v === 'bigint' ? v.toString() : v;
  return { id, type, created: at, data };
}

/** Keeper-event → webhook payload (thin alias over `eventToWebhook`). */
export function keeperEventToWebhook(e: KeeperEvent, id?: string): WebhookEvent {
  return eventToWebhook(e, id);
}

/**
 * An `onEvent` sink for `IsubKeeper`: delivers every lifecycle event as a signed
 * webhook (fire-and-forget, ordered). Pass to `new IsubKeeper(.., { onEvent })`.
 */
export function keeperWebhookSink(dispatcher: WebhookDispatcher): (e: KeeperEvent) => void {
  return (e) => {
    void dispatcher.enqueue(keeperEventToWebhook(e));
  };
}

// @isub/checkout — the embeddable loader a merchant drops on their own site.
//
//   import { iSubCheckout } from '@isub/checkout';
//   const r = await iSubCheckout.open({ planId, budget: '0.2' });
//   if (r.ok) console.log('subscribed', r.mandateId);
//
// It opens iSub's hosted consent page in an IFRAME (a modal). The terms the user reviews are
// read FROM CHAIN inside that iframe, on iSub's origin — the merchant page can't restyle or
// spoof them (trusted display). The only channel back is a postMessage we validate by origin.
// Dependency-free vanilla TS so it bundles tiny and drops into any stack.

export interface CheckoutOptions {
  /** The merchant's plan id (0x…). */
  planId: string;
  /** Total to authorize, in SUI (decimal string). The user's hard spend cap for this subscription. */
  budget: string;
  /** Network the plan lives on. Defaults to the checkout host's default (testnet). */
  network?: 'testnet' | 'localnet';
  /** Subscription lifetime in days (default 30). */
  ttlDays?: number;
  /** PAYG per-charge ceiling, in SUI (defaults to the plan's rate cap). */
  maxPerCharge?: string;
  /** Also capture a plain-language signed consent (signPersonalMessage) before authorizing. */
  consent?: boolean;
  /** Override the iSub checkout host (default https://localhost:3000/checkout for dev). */
  checkoutUrl?: string;
  /**
   * How to present the checkout. 'iframe' (default) = an in-page modal (trusted display, production).
   * 'popup' = a top-level window — use it on localhost, where the browser silently refuses to load a
   * self-signed-cert iframe and some wallets won't inject into a cross-origin frame.
   */
  mode?: 'iframe' | 'popup';
}

export interface CheckoutResult {
  ok: boolean;
  mandateId?: string;
  accountId?: string;
  reason?: string;
}

const DEFAULT_CHECKOUT_URL = 'https://localhost:3000/checkout';

function buildUrl(opts: CheckoutOptions): string {
  const base = opts.checkoutUrl ?? DEFAULT_CHECKOUT_URL;
  const q = new URLSearchParams({ planId: opts.planId, budget: opts.budget, origin: window.location.origin });
  if (opts.network) q.set('network', opts.network);
  if (opts.ttlDays != null) q.set('ttlDays', String(opts.ttlDays));
  if (opts.maxPerCharge) q.set('maxPerCharge', opts.maxPerCharge);
  if (opts.consent) q.set('consent', '1');
  return `${base}?${q.toString()}`;
}

interface CheckoutMessage { source?: string; type?: string; ok?: boolean; mandateId?: string; accountId?: string; reason?: string }

/** Top-level popup flow (no iframe) — robust on localhost / for wallets that don't inject into frames. */
function openPopup(url: string, checkoutOrigin: string): Promise<CheckoutResult> {
  return new Promise<CheckoutResult>((resolve) => {
    const w = 460;
    const h = 680;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const popup = window.open(url, 'isub-checkout', `popup=1,width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)}`);
    if (!popup) return resolve({ ok: false, reason: 'popup blocked — allow popups for this site, then retry' });

    let settled = false;
    const finish = (r: CheckoutResult): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      try { popup.close(); } catch { /* already closed */ }
      resolve(r);
    };
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== checkoutOrigin) return; // only trust the checkout origin
      const d = e.data as CheckoutMessage;
      if (d?.source !== 'isub-checkout') return;
      if (d.type === 'isub:result') finish({ ok: !!d.ok, mandateId: d.mandateId, accountId: d.accountId });
      else if (d.type === 'isub:cancel') finish({ ok: false, reason: 'cancelled' });
    };
    const poll = setInterval(() => { if (popup.closed) finish({ ok: false, reason: 'dismissed' }); }, 500);
    window.addEventListener('message', onMessage);
  });
}

export const iSubCheckout = {
  /** Open the checkout modal. Resolves when the user finishes, cancels, or dismisses. */
  open(opts: CheckoutOptions): Promise<CheckoutResult> {
    const url = buildUrl(opts);
    const checkoutOrigin = new URL(url).origin;
    if (opts.mode === 'popup') return openPopup(url, checkoutOrigin);

    return new Promise<CheckoutResult>((resolve) => {
      const overlay = document.createElement('div');
      overlay.setAttribute('style', [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'background:rgba(8,10,14,0.55)', 'display:flex', 'align-items:center', 'justify-content:center',
        'padding:16px', '-webkit-backdrop-filter:blur(2px)', 'backdrop-filter:blur(2px)',
      ].join(';'));

      const frame = document.createElement('iframe');
      frame.src = url;
      frame.setAttribute('allow', 'clipboard-write');
      frame.setAttribute('style', [
        'width:100%', 'max-width:440px', 'height:620px', 'max-height:92vh',
        'border:0', 'border-radius:14px', 'background:transparent',
        'box-shadow:0 24px 70px rgba(0,0,0,0.45)',
      ].join(';'));
      overlay.appendChild(frame);

      let settled = false;
      const finish = (r: CheckoutResult): void => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        window.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(r);
      };
      const onMessage = (e: MessageEvent): void => {
        if (e.origin !== checkoutOrigin) return; // only trust the checkout origin
        const d = e.data as { source?: string; type?: string; ok?: boolean; mandateId?: string; accountId?: string; reason?: string };
        if (d?.source !== 'isub-checkout') return;
        if (d.type === 'isub:result') finish({ ok: !!d.ok, mandateId: d.mandateId, accountId: d.accountId });
        else if (d.type === 'isub:cancel') finish({ ok: false, reason: 'cancelled' });
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') finish({ ok: false, reason: 'dismissed' });
      };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish({ ok: false, reason: 'dismissed' });
      });

      window.addEventListener('message', onMessage);
      window.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
    });
  },
};

// Also expose as a global for plain <script> embedders.
declare global {
  interface Window {
    iSubCheckout: typeof iSubCheckout;
  }
}
if (typeof window !== 'undefined') window.iSubCheckout = iSubCheckout;

// AfterDark — a creator-subscription site (OnlyFans-style) that integrates iSub as a payment channel.
// The user picks "Pay with Sui" → the iSub checkout iframe opens (terms read on-chain, trusted
// display) → the wallet signs a FIXED-recurring mandate → the locked content unblurs.
// Set the FIXED plan via ?plan=0x… or the PLAN_ID default below.
import { iSubCheckout } from './loader';

const PLAN_ID =
  new URLSearchParams(location.search).get('plan') ||
  '0xb70e7f3cf66696a4049dc12ff3c33f2a8610e50812f5066c82e3fd2bf4d642c1'; // ← demo FIXED plan; replace with your own
const BUDGET = '0.1'; // SUI — the subscriber's hard spend cap for this subscription

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

$('paySui').addEventListener('click', async () => {
  const status = $('status');
  status.className = 'status';
  status.textContent = 'Opening iSub…';
  const r = await iSubCheckout.open({ planId: PLAN_ID, budget: BUDGET, network: 'testnet', consent: true, mode: 'popup' });
  if (r.ok) {
    document.body.classList.add('unlocked'); // un-blur the gated content
    status.className = 'status ok';
    status.innerHTML = `✓ Subscribed — <span class="mono">${(r.mandateId ?? '').slice(0, 16)}…</span> · funds stay in your wallet, cancel anytime`;
  } else if (r.reason === 'cancelled' || r.reason === 'dismissed') {
    status.textContent = '';
  } else {
    status.className = 'status err';
    status.textContent = `✗ ${r.reason ?? 'not completed'}`;
  }
});

// Cortex AI — a fictional AI provider selling metered MCP services (PAYG, pay-per-call) AND token
// packages (FIXED, monthly recurring), all payable via a Sui mandate through iSub. Each "Subscribe
// with Sui" button carries data-plan + data-budget; one delegated handler opens the iSub checkout
// (popup mode → robust on localhost). Defaults point at the two demo testnet plans — for a polished
// demo, create one plan per offering at /merchant and drop its id into the card's data-plan.
// (?plan=0x… overrides EVERY button, for quick testing.)
import { iSubCheckout } from './loader';

const override = new URLSearchParams(location.search).get('plan');

document.querySelectorAll<HTMLButtonElement>('button[data-plan]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const card = btn.closest('.card') as HTMLElement;
    const status = card.querySelector('.status') as HTMLElement;
    const planId = override || (btn.dataset.plan ?? '');
    const budget = btn.dataset.budget ?? '0.2';
    status.className = 'status';
    status.textContent = 'Opening iSub…';
    const r = await iSubCheckout.open({ planId, budget, network: 'testnet', consent: true, mode: 'popup' });
    if (r.ok) {
      card.classList.add('active');
      status.className = 'status ok';
      status.innerHTML = `✓ Subscribed — <span class="mono">${(r.mandateId ?? '').slice(0, 14)}…</span>`;
    } else if (r.reason === 'cancelled' || r.reason === 'dismissed') {
      status.textContent = '';
    } else {
      status.className = 'status err';
      status.textContent = `✗ ${r.reason ?? 'not completed'}`;
    }
  });
});

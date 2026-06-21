// CityGrid Utilities — a water/electricity bill site that integrates iSub for autopay. The user picks
// "Pay with Sui" → the iSub checkout iframe opens (terms read on-chain) → the wallet signs a PAYG
// (metered, capped) mandate → autopay is enabled and future bills are pulled within the signed cap.
// Set the PAYG plan via ?plan=0x… or the PLAN_ID default below.
import { iSubCheckout } from './loader';

const PLAN_ID =
  new URLSearchParams(location.search).get('plan') ||
  '0x6ff9664b6435bdeef6e24e7fdbb5caa296fab1194550b767eac8e428870825c3'; // ← demo PAYG plan; replace with your own
const BUDGET = '0.5'; // SUI — the monthly autopay cap the resident signs (hard ceiling)

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

$('paySui').addEventListener('click', async () => {
  const status = $('status');
  status.className = 'status';
  status.textContent = 'Opening iSub…';
  const r = await iSubCheckout.open({ planId: PLAN_ID, budget: BUDGET, network: 'testnet', consent: true, mode: 'popup' });
  if (r.ok) {
    document.body.classList.add('enrolled'); // flip the bill to "autopay on"
    status.className = 'status ok';
    status.innerHTML = `✓ Autopay enabled — <span class="mono">${(r.mandateId ?? '').slice(0, 16)}…</span> · future bills paid automatically within your ${BUDGET} SUI cap`;
  } else if (r.reason === 'cancelled' || r.reason === 'dismissed') {
    status.textContent = '';
  } else {
    status.className = 'status err';
    status.textContent = `✗ ${r.reason ?? 'not completed'}`;
  }
});

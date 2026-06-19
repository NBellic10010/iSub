import { iSubCheckout } from './loader';

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const result = byId<HTMLDivElement>('result');
const setResult = (s: string): void => {
  result.textContent = s;
};

byId<HTMLButtonElement>('subscribe').addEventListener('click', async () => {
  const planId = byId<HTMLInputElement>('planId').value.trim();
  const budget = byId<HTMLInputElement>('budget').value.trim() || '0.2';
  const network = byId<HTMLSelectElement>('network').value as 'testnet' | 'localnet';
  if (!planId) {
    setResult('enter a plan id first');
    return;
  }
  setResult('opening iSub checkout…');
  // The merchant passes only planId + budget — the real terms are read on-chain inside the iframe.
  const r = await iSubCheckout.open({ planId, budget, network, consent: true });
  setResult(r.ok ? `✓ subscribed — mandate ${r.mandateId}` : `✗ ${r.reason ?? 'not completed'}`);
});

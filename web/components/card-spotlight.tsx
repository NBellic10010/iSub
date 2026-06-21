'use client';
import { useEffect } from 'react';

// Mounted once. Tracks the pointer over any `.feature` card and writes its local
// coordinates to CSS vars (--mx/--my), so the card's ::before spotlight + ::after
// border-glow follow the cursor (Stripe/Linear-style hover). rAF-throttled, passive.
export function CardSpotlight() {
  useEffect(() => {
    let raf = 0;
    let lx = 0;
    let ly = 0;
    let card: HTMLElement | null = null;
    const apply = () => {
      raf = 0;
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${lx - r.left}px`);
      card.style.setProperty('--my', `${ly - r.top}px`);
    };
    const onMove = (e: PointerEvent) => {
      const c = (e.target as HTMLElement | null)?.closest?.('.feature') as HTMLElement | null;
      if (!c) return;
      card = c;
      lx = e.clientX;
      ly = e.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return null;
}

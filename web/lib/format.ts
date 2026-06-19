export const MIST = 1_000_000_000n;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a decimal SUI string into bigint MIST. Throws on malformed input. */
export function toMist(sui: string): bigint {
  const t = sui.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`enter a positive SUI amount (got "${sui}")`);
  const [whole, frac = ''] = t.split('.');
  return BigInt(whole) * MIST + BigInt((frac + '000000000').slice(0, 9) || '0');
}

/** Format bigint MIST as a SUI string (trailing zeros trimmed). */
export function fmtSui(mist: bigint): string {
  const neg = mist < 0n;
  const m = neg ? -mist : mist;
  const frac = (m % MIST).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${m / MIST}${frac ? '.' + frac : ''}`;
}

/** Short 0x… form for addresses / object ids. */
export const shortId = (id: string): string => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

import type { Fundamentals } from './types';
import type { Screener } from './screener';

/**
 * Ratio helpers. There is NO simulated fundamentals generator any more (Round 19 audit): values come from the provider via
 * lib/yahooFundamentals.ts → `mergeLive`, and anything missing is null → "N/A".
 */

export const fundamentalsOf = (s: Screener): Fundamentals => ({
  marketCapCr: s.marketCapCr,
  pe: s.pe,
  bookValue: s.bookValue,
  dividendYield: s.dividendYield,
  roce: s.roce,
  roe: s.roe,
  debtToEquity: s.debtToEquity,
  promoterHolding: s.holding?.promoters ?? null,
  eps: s.eps,
});

export type Tone = 'good' | 'ok' | 'bad' | 'na';
/** Screener-style traffic lights for each ratio — 'na' whenever the value is unavailable. P/E has no sector reference, so it is not coloured. */
export function ratioTone(key: keyof Fundamentals, f: Fundamentals, _sector?: string): Tone {
  const v = f[key];
  if (v === null || v === undefined || !Number.isFinite(v)) return 'na';
  switch (key) {
    case 'roce':
    case 'roe':
      return v >= 15 ? 'good' : v >= 10 ? 'ok' : 'bad';
    case 'debtToEquity':
      return v <= 0.5 ? 'good' : v <= 1 ? 'ok' : 'bad';
    case 'promoterHolding':
      return v >= 50 ? 'good' : v >= 25 ? 'ok' : 'bad';
    case 'dividendYield':
      return v >= 2 ? 'good' : v >= 0.5 ? 'ok' : 'na';
    default:
      return 'na';
  }
}

/** "N/A" for null / non-finite, otherwise the formatted number. */
export const orNA = (v: number | null | undefined, fmt: (n: number) => string): string => (typeof v === 'number' && Number.isFinite(v) ? fmt(v) : 'N/A');

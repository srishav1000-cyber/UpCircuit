import type { Instrument } from './types';

export type BudgetBand = 'under50' | '50to100' | '100to500';

export const BUDGET_BANDS: { id: BudgetBand; label: string; min: number; max: number }[] = [
  { id: 'under50', label: 'Under ₹50', min: 0, max: 50 },
  { id: '50to100', label: '₹50 - ₹100', min: 50, max: 100 },
  { id: '100to500', label: '₹100 - ₹500', min: 100, max: 500 },
];

/** min ≤ ltp < max (so a ₹50.00 stock sits in exactly one tab). */
export const inBand = (ltp: number, b: { min: number; max: number }) => Number.isFinite(ltp) && ltp > 0 && ltp >= b.min && ltp < b.max;

/**
 * Cheap pre-filter over the whole master (7.5k rows) using a price function that does NOT create engine quotes
 * (`basePrice`); callers then touch only the returned handful for live LTP. Deterministic order: symbol ascending.
 */
export function budgetCandidates(instruments: Instrument[], band: { min: number; max: number }, priceOf: (symbol: string) => number, limit: number): Instrument[] {
  const out: Instrument[] = [];
  for (const i of instruments) {
    if (inBand(priceOf(i.symbol), band)) out.push(i);
  }
  out.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  return out.slice(0, limit);
}

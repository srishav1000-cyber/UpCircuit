// Fundamentals that move with the price. Yahoo supplies the per-share inputs (EPS, book value, shares) once; the price-dependent
// figures are recomputed from the latest SmartAPI LTP on every render, so they follow the stream instead of freezing at Yahoo's snapshot:
//   Market cap = LTP × total shares      P/E = LTP ÷ EPS      P/B = LTP ÷ book value per share
// Provenance: SmartAPI-derived while the SmartAPI stream supplies the price ('live' ticks, or the 'snapshot' last prices when the market
// is closed); otherwise the Yahoo value (or N/A) — nothing is estimated.
import type { FeedMode } from './market';

export type CellSource = 'smartapi' | 'yahoo' | 'computed' | 'na';
export interface LiveCell { value: number | null; source: CellSource; formula?: string }
export interface LiveFundamentalsOut { marketCapCr: LiveCell; pe: LiveCell; pb: LiveCell }

const pos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function liveFundamentals(i: { ltp: number; mode: FeedMode | string; sharesCr?: number | null; eps?: number | null; bookValue?: number | null; yahooMcapCr?: number | null; yahooPe?: number | null }): LiveFundamentalsOut {
  const stream = (i.mode === 'live' || i.mode === 'snapshot') && pos(i.ltp);
  const mcapLive = stream && pos(i.sharesCr);
  const peLive = stream && pos(i.eps);
  return {
    marketCapCr: mcapLive ? { value: i.ltp * (i.sharesCr as number), source: 'smartapi', formula: 'SmartAPI LTP × total shares' } : pos(i.yahooMcapCr) ? { value: i.yahooMcapCr, source: 'yahoo' } : { value: null, source: 'na' },
    pe: peLive ? { value: i.ltp / (i.eps as number), source: 'smartapi', formula: 'SmartAPI LTP ÷ EPS' } : pos(i.yahooPe) ? { value: i.yahooPe, source: 'yahoo' } : { value: null, source: 'na' },
    pb: pos(i.bookValue) && pos(i.ltp) ? { value: i.ltp / i.bookValue, source: stream ? 'smartapi' : 'computed', formula: 'LTP ÷ book value per share' } : { value: null, source: 'na' },
  };
}

/** badge text for a SmartAPI-derived value: [SmartAPI Live] while ticks stream, [SmartAPI Last Price] after the close */
export const smartApiLabel = (mode: FeedMode | string): string => (mode === 'live' ? 'SmartAPI Live' : 'SmartAPI Last Price');

import type { Instrument, Quote } from './types';

/**
 * Screener-style stock snapshot for ANY instrument (all 8,100+ NSE + BSE names) — REAL FIGURES ONLY.
 *
 * Audit (Round 19): the former deterministic hash/PRNG "estimates" (P/E, ROE, ROCE, book value, quarterly P&L, shareholding, face value,
 * sector P/E) are gone. Every field is either
 *   • taken from the live quote (market cap, dividend yield — Yahoo / SmartAPI via the engine), or
 *   • overlaid from the fundamentals provider by `mergeLive` (lib/yahooFundamentals.ts), or
 *   • `null` → rendered as "N/A".
 * The SmartAPI scrip master (lib/scripMaster.ts) carries only token / symbol / name / expiry / strike / lot size / instrument type /
 * exchange segment / tick size — it has NO P/E, market cap or 52-week range, so none of those can come from it.
 * Today's High/Low is NEVER shown as a 52-week range any more.
 */

export interface QuarterRow {
  /** e.g. "Sep 2026" */
  label: string;
  sales: number;
  expenses: number;
  operatingProfit: number;
  opmPct: number;
  netProfit: number;
  eps: number;
}

export interface Holding3 {
  promoters: number;
  /** FII + DII combined — the provider does not split them */
  institutions: number;
  public: number;
}

export interface Screener {
  marketCapCr: number | null;
  pe: number | null;
  /** no data source for industry P/E → always null today */
  industryPe: number | null;
  bookValue: number | null;
  dividendYield: number | null;
  roce: number | null;
  roe: number | null;
  /** not in the SmartAPI scrip master or the fundamentals provider → null */
  faceValue: number | null;
  debtToEquity: number | null;
  eps: number | null;
  high52: number | null;
  low52: number | null;
  /** [] = not available */
  quarters: QuarterRow[];
  holding: Holding3 | null;
  /** `live` = at least some figures come from the provider; `na` lists every field that has no real value */
  source: { live: boolean; quarters: boolean; holding: boolean; na: string[]; asOf?: number };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The latest 5 quarter-end labels (oldest → newest) completed before `now`. */
export function quarterLabels(now = new Date(), n = 5): string[] {
  let y = now.getUTCFullYear();
  let m = Math.floor(now.getUTCMonth() / 3) * 3 - 1; // last completed quarter-end month
  if (m < 0) {
    m += 12;
    y -= 1;
  }
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.unshift(`${MONTHS[m]} ${y}`);
    m -= 3;
    if (m < 0) {
      m += 12;
      y -= 1;
    }
  }
  return out;
}

type Q = Pick<Quote, 'symbol' | 'sector' | 'ltp' | 'prevClose' | 'mcapCr' | 'dividendYield' | 'high' | 'low'>;

const posOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export const NA_FIELDS = ['Market Cap', 'P/E', 'Industry P/E', 'Book Value', 'Dividend Yield', 'ROE', 'ROCE', 'EPS', 'D/E', 'Face Value', '52W range', 'Quarterly results', 'Shareholding'];

/** What is knowable from the quote alone. Never throws, never invents a number. `_now` is kept for API compatibility. */
export function getScreener(q: Q | null | undefined, _now = new Date()): Screener {
  const mcap = posOrNull(q?.mcapCr);
  const dy = posOrNull(q?.dividendYield);
  const na = NA_FIELDS.filter((f) => !(f === 'Market Cap' && mcap !== null) && !(f === 'Dividend Yield' && dy !== null));
  return {
    marketCapCr: mcap,
    pe: null,
    industryPe: null,
    bookValue: null,
    dividendYield: dy,
    roce: null,
    roe: null,
    faceValue: null,
    debtToEquity: null,
    eps: null,
    high52: null,
    low52: null,
    quarters: [],
    holding: null,
    source: { live: false, quarters: false, holding: false, na },
  };
}

/** Where `v` sits between lo and hi, 0–100 (clamped). */
export const rangePct = (v: number, lo: number, hi: number) => (hi > lo ? Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100)) : 50);

/**
 * Top-N same-sector peers by REAL market cap (names Yahoo has not priced yet rank last) — computed WITHOUT creating engine quotes for the whole sector,
 * so only the returned handful need `engine.touch()`.
 */
export function peerCandidates(instruments: Instrument[] | null | undefined, symbol: string, sector: string, n = 5, capOf?: (symbol: string) => number): Instrument[] {
  if (!Array.isArray(instruments)) return [];
  const scored: { i: Instrument; cap: number }[] = [];
  for (const i of instruments) {
    if (i.symbol === symbol || (i.sector ?? 'Others') !== sector) continue;
    scored.push({ i, cap: capOf?.(i.symbol) ?? 0 });
  }
  scored.sort((a, b) => b.cap - a.cap || (a.i.symbol < b.i.symbol ? -1 : 1));
  return scored.slice(0, n).map((x) => x.i);
}

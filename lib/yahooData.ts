// REAL delayed market data from Yahoo Finance — pure parsing (server + client safe). No random numbers anywhere in this path.
import type { Candle, Timeframe } from './types';
import { YAHOO_INDEX } from './yahoo';

export interface YahooRow {
  /** plain symbol (RELIANCE) or index id (NIFTY) */
  symbol: string;
  ltp: number;
  prevClose: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  avgVolume?: number;
  mcapCr?: number;
  /** shares outstanding, in crore */
  sharesCr?: number;
  /** trailing dividend yield, % */
  dividendYield?: number;
  /** exchange time of the last trade, epoch ms */
  marketTime?: number;
  isIndex?: boolean;
}

const pos = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
const nonNeg = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);
const INDEX_BY_YAHOO = new Map(Object.entries(YAHOO_INDEX).map(([id, y]) => [y, id]));

/** "RELIANCE.NS" → RELIANCE, "M%26M.NS" / "M&M.NS" → M&M, "^NSEI" → NIFTY (index). */
export function fromYahooSymbol(ys: string): { symbol: string; isIndex: boolean } {
  const idx = INDEX_BY_YAHOO.get(ys);
  if (idx) return { symbol: idx, isIndex: true };
  return { symbol: decodeURIComponent(ys).replace(/\.(NS|BO)$/i, ''), isIndex: false };
}

/** v7 /finance/quote → rows. Rows without a usable price or previous close are dropped. */
export function parseQuoteRows(body: unknown): YahooRow[] {
  const res = (body as { quoteResponse?: { result?: Record<string, unknown>[] } })?.quoteResponse?.result;
  if (!Array.isArray(res)) return [];
  const out: YahooRow[] = [];
  for (const r of res) {
    const ltp = pos(r.regularMarketPrice);
    const prev = pos(r.regularMarketPreviousClose) ?? pos(r.previousClose);
    if (!ltp || !prev || typeof r.symbol !== 'string') continue;
    const { symbol, isIndex } = fromYahooSymbol(r.symbol);
    const mcap = pos(r.marketCap);
    const shares = pos(r.sharesOutstanding);
    const t = pos(r.regularMarketTime);
    const dy = nonNeg(r.trailingAnnualDividendYield);
    out.push({
      symbol, ltp, prevClose: prev, isIndex,
      open: pos(r.regularMarketOpen), high: pos(r.regularMarketDayHigh), low: pos(r.regularMarketDayLow),
      volume: nonNeg(r.regularMarketVolume), avgVolume: pos(r.averageDailyVolume3Month) ?? pos(r.averageDailyVolume10Day),
      mcapCr: mcap ? mcap / 1e7 : undefined,
      sharesCr: shares ? shares / 1e7 : mcap ? mcap / ltp / 1e7 : undefined,
      dividendYield: dy !== undefined ? dy * 100 : undefined,
      marketTime: t ? t * 1000 : undefined,
    });
  }
  return out;
}

/** v8 chart → one row from `meta` (+ first bar open). Used when the crumb flow / v7 endpoint is unavailable. */
export function parseChartRow(symbol: string, isIndex: boolean, body: unknown): YahooRow | null {
  const r = (body as { chart?: { result?: { meta?: Record<string, unknown>; indicators?: { quote?: { open?: unknown[] }[] } }[] } })?.chart?.result?.[0];
  const m = r?.meta;
  const ltp = pos(m?.regularMarketPrice);
  const prev = pos(m?.chartPreviousClose) ?? pos(m?.previousClose);
  if (!m || !ltp || !prev) return null;
  const t = pos(m.regularMarketTime);
  const open = (r?.indicators?.quote?.[0]?.open ?? []).find((x) => pos(x));
  return { symbol, isIndex, ltp, prevClose: prev, open: pos(open), high: pos(m.regularMarketDayHigh), low: pos(m.regularMarketDayLow), volume: nonNeg(m.regularMarketVolume), marketTime: t ? t * 1000 : undefined };
}

/** Timeframe → Yahoo interval + range. 1m is capped at 7 days by Yahoo, 5m/15m at 60 days, 1h at ~2 years. */
export const YAHOO_TF: Record<Timeframe, { interval: string; range: string }> = {
  '1m': { interval: '1m', range: '5d' },
  '5m': { interval: '5m', range: '1mo' },
  '15m': { interval: '15m', range: '1mo' },
  '1h': { interval: '60m', range: '6mo' },
  '1D': { interval: '1d', range: '2y' },
  '1W': { interval: '1wk', range: '5y' },
  '1M': { interval: '1mo', range: '10y' },
  '1Y': { interval: '1d', range: '1y' },
  '5Y': { interval: '1wk', range: '5y' },
  '10Y': { interval: '1mo', range: '10y' },
};

const IST = 19800;
/** v8 chart → candles (IST-shifted seconds, ascending, de-duplicated). Bars with any null OHLC are skipped. */
export function parseBars(body: unknown, intraday: boolean): Candle[] {
  const r = (body as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: Record<string, (number | null)[]>[] } }[] } })?.chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return [];
  const byTime = new Map<number, Candle>();
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (![o, h, l, c].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) continue;
    const shifted = ts[i] + IST;
    const time = intraday ? shifted : Math.floor(shifted / 86400) * 86400;
    byTime.set(time, { time, open: o as number, high: Math.max(h as number, o as number, c as number), low: Math.min(l as number, o as number, c as number), close: c as number, volume: typeof v === 'number' && v > 0 ? v : 0 });
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

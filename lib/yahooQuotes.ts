// Server-side Yahoo fetchers for /api/quotes and /api/bars. v7 batch quote (cookie + crumb) first; per-symbol v8 chart meta as the fallback.
import { getSession, type Session } from './yahooFundamentals';
import { parseBars, parseChartRow, parseQuoteRows, YAHOO_TF, type YahooRow } from './yahooData';
import { YAHOO_INDEX, toYahooSymbol } from './yahoo';
import type { Candle, Timeframe } from './types';
import { TF_CONFIG } from './market';
import { RANGE_SPECS, acceptDirect, resolveRange } from './historicalEngine';

const BASE = () => process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com';
const COOKIE_URL = () => process.env.YAHOO_COOKIE_URL || 'https://fc.yahoo.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; UpCircuit)', Accept: 'application/json,text/plain,*/*' };

export interface Want { symbol: string; exch?: 'NSE' | 'BSE' }
const ysOf = (w: Want) => (YAHOO_INDEX[w.symbol] ? YAHOO_INDEX[w.symbol] : toYahooSymbol(w.symbol, w.exch ?? 'NSE'));

async function v7(wants: Want[], s: Session, timeoutMs: number): Promise<{ status: number; rows: YahooRow[] }> {
  const list = wants.map(ysOf).join(',');
  try {
    const res = await fetch(`${BASE()}/v7/finance/quote?symbols=${encodeURIComponent(list)}&crumb=${encodeURIComponent(s.crumb)}`, { headers: { ...HEADERS, Cookie: s.cookie }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { status: 200, rows: parseQuoteRows(await res.json()) } : { status: res.status, rows: [] };
  } catch {
    return { status: 0, rows: [] };
  }
}

async function chartRow(w: Want, timeoutMs: number): Promise<YahooRow | null> {
  const isIndex = !!YAHOO_INDEX[w.symbol];
  try {
    const res = await fetch(`${BASE()}/v8/finance/chart/${ysOf(w)}?interval=1m&range=1d`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? parseChartRow(w.symbol, isIndex, await res.json()) : null;
  } catch {
    return null;
  }
}

/** Real delayed quotes for up to ~60 symbols. Symbols Yahoo has no price for are simply absent from the result. */
export async function fetchQuoteRows(wants: Want[], timeoutMs = 7000): Promise<{ rows: YahooRow[]; via: 'v7' | 'v8' | 'none' }> {
  if (!wants.length) return { rows: [], via: 'none' };
  let s = await getSession(BASE(), COOKIE_URL(), false, timeoutMs);
  if (s) {
    let r = await v7(wants, s, timeoutMs);
    if (r.status === 401 || r.status === 403) {
      s = await getSession(BASE(), COOKIE_URL(), true, timeoutMs);
      if (s) r = await v7(wants, s, timeoutMs);
    }
    if (r.rows.length) {
      // an NSE symbol Yahoo only lists on BSE (.BO) comes back empty here — retry just those through the chart endpoint
      const got = new Set(r.rows.map((x) => x.symbol));
      const missing = wants.filter((w) => !got.has(w.symbol)).slice(0, 8);
      const extra = (await Promise.all(missing.map((w) => chartRow(w, timeoutMs)))).filter((x): x is YahooRow => !!x);
      return { rows: [...r.rows, ...extra], via: 'v7' };
    }
  }
  // fallback: chart meta, 8 at a time
  const out: YahooRow[] = [];
  for (let i = 0; i < wants.length; i += 8) {
    const part = await Promise.all(wants.slice(i, i + 8).map((w) => chartRow(w, timeoutMs)));
    part.forEach((x) => x && out.push(x));
  }
  return { rows: out, via: out.length ? 'v8' : 'none' };
}

/** Real OHLCV bars for one symbol / index at a timeframe (IST-shifted seconds). */
export async function fetchBars(w: Want, tf: Timeframe, timeoutMs = 8000): Promise<Candle[]> {
  const { interval, range } = YAHOO_TF[tf];
  const intraday = TF_CONFIG[tf].kind === 'intraday';
  const tryOne = async (x: Want, iv = interval, rg = range) => {
    try {
      const res = await fetch(`${BASE()}/v8/finance/chart/${ysOf(x)}?interval=${iv}&range=${rg}`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? parseBars(await res.json(), intraday) : [];
    } catch {
      return [];
    }
  };
  const venues = YAHOO_INDEX[w.symbol] ? [w] : (w.exch ?? 'NSE') === 'NSE' ? [{ symbol: w.symbol, exch: 'NSE' as const }, { symbol: w.symbol, exch: 'BSE' as const }] : [{ symbol: w.symbol, exch: 'BSE' as const }, { symbol: w.symbol, exch: 'NSE' as const }];
  const spec = RANGE_SPECS[tf];
  if (!spec) {
    for (const v of venues) {
      const b = await tryOne(v);
      if (b.length) return b;
    }
    return [];
  }
  // 1D / 1W / 1M / 1Y / 5Y / 10Y: use Yahoo's own bars when they are at the right resolution, otherwise rebuild them from daily bars
  for (const v of venues) {
    const direct = await tryOne(v);
    const ok = acceptDirect(tf, direct);
    if (ok && ok.length) return ok;
    const daily = tf === '1D' || tf === '1Y' ? [] : await tryOne(v, '1d', spec.dailyRange);
    const r = resolveRange(tf, direct, daily);
    if (r.bars.length) return r.bars;
  }
  return [];
}

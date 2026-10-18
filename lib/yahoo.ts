// Free live-quote fallback: Yahoo Finance public chart endpoint (no key, no crumb). Used by scripts/angel-relay.ts when
// SmartAPI is offline / not configured. Pure fetch + parsing so it is testable against a mock (YAHOO_BASE).
// NOTE: unofficial endpoint — may be rate-limited or change; NSE data can be delayed.

export interface YahooTick {
  symbol: string;
  ltp: number;
  open?: number;
  high?: number;
  low?: number;
  /** previous close */
  close?: number;
  volume?: number;
  /** epoch ms */
  ts: number;
}

export const YAHOO_INDEX: Record<string, string> = { NIFTY: '^NSEI', SENSEX: '^BSESN', BANKNIFTY: '^NSEBANK', INDIAVIX: '^INDIAVIX' };

/** NSE → `.NS`, BSE-only → `.BO`. Index tickers pass through. */
export const toYahooSymbol = (symbol: string, exch: 'NSE' | 'BSE' = 'NSE') => `${symbol.toUpperCase().replace(/&/g, '%26')}${exch === 'BSE' ? '.BO' : '.NS'}`;

const num = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
const first = (a: unknown): number | undefined => (Array.isArray(a) ? a.find((x) => num(x) !== undefined) : undefined);

/** Parse a v8 chart response into a tick (symbol is supplied by the caller). Returns null when there is no usable price. */
export function parseYahooChart(symbol: string, body: unknown): YahooTick | null {
  const r = (body as { chart?: { result?: { meta?: Record<string, unknown>; indicators?: { quote?: { open?: unknown[] }[] } }[] } })?.chart?.result?.[0];
  const m = r?.meta;
  const ltp = num(m?.regularMarketPrice);
  if (!m || ltp === undefined) return null;
  const t = num(m.regularMarketTime);
  return {
    symbol,
    ltp,
    open: first(r?.indicators?.quote?.[0]?.open),
    high: num(m.regularMarketDayHigh),
    low: num(m.regularMarketDayLow),
    close: num(m.chartPreviousClose) ?? num(m.previousClose),
    volume: typeof m.regularMarketVolume === 'number' && m.regularMarketVolume >= 0 ? m.regularMarketVolume : undefined,
    ts: t ? t * 1000 : Date.now(),
  };
}

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; UpCircuit-relay)', Accept: 'application/json' };

export type YahooResult = { ok: true; tick: YahooTick } | { ok: false; status: number };

/** One quote. `yahooSymbol` is e.g. RELIANCE.NS or ^NSEI. */
export async function fetchYahooQuote(symbol: string, yahooSymbol: string, base = process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com', timeoutMs = 6000): Promise<YahooResult> {
  try {
    const res = await fetch(`${base}/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status };
    const tick = parseYahooChart(symbol, await res.json());
    return tick ? { ok: true, tick } : { ok: false, status: 204 };
  } catch {
    return { ok: false, status: 0 };
  }
}

/* ───────────── previous-session 1-minute bars (off-market replay) ───────────── */

export interface SessionBar {
  /** epoch seconds */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** v8 chart (interval=1m, range=5d) → the LAST session's 1-minute bars (IST trading date), or null if fewer than 30 usable bars. */
export function parseYahooSession(body: unknown): { date: string; bars: SessionBar[] } | null {
  const r = (body as { chart?: { result?: { timestamp?: unknown[]; indicators?: { quote?: Record<string, unknown[]>[] } }[] } })?.chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return null;
  const byDate = new Map<string, SessionBar[]>();
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const o = num(q.open?.[i]), h = num(q.high?.[i]), l = num(q.low?.[i]), c = num(q.close?.[i]);
    if (typeof t !== 'number' || o === undefined || h === undefined || l === undefined || c === undefined) continue;
    const v = q.volume?.[i];
    const date = new Date((t + 19800) * 1000).toISOString().slice(0, 10); // IST calendar date
    const arr = byDate.get(date) ?? [];
    arr.push({ t, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume: typeof v === 'number' && v > 0 ? v : 0 });
    byDate.set(date, arr);
  }
  const dates = Array.from(byDate.keys()).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const bars = byDate.get(dates[i])!;
    if (bars.length >= 30) return { date: dates[i], bars };
  }
  return null;
}

// Multi-year chart ranges. 1Y → daily candles (≤ 252), 5Y → weekly (≤ 260), 10Y → monthly (≤ 120) — plus 1W / 1M at their own resolution.
//
// Yahoo's weekly / monthly endpoints are the first thing to fail (rate-limit, empty body, or a body at the WRONG resolution such as intraday bars
// for a 10-year request). Instead of a blank chart we validate what came back and, when it is unusable, rebuild the candles by aggregating the
// DAILY series (which Yahoo serves reliably) into weeks / months. Nothing is invented: every candle is real data or a real aggregate of it.
import type { Candle, Timeframe } from './types';

export type Resolution = 'daily' | 'weekly' | 'monthly';
export interface RangeSpec { res: Resolution; /** newest N candles kept */ keep: number; /** the daily request that can rebuild it */ dailyRange: '1y' | '2y' | '5y' | '10y' }

export const RANGE_SPECS: Partial<Record<Timeframe, RangeSpec>> = {
  '1D': { res: 'daily', keep: Infinity, dailyRange: '2y' },
  '1W': { res: 'weekly', keep: Infinity, dailyRange: '5y' },
  '1M': { res: 'monthly', keep: Infinity, dailyRange: '10y' },
  '1Y': { res: 'daily', keep: 252, dailyRange: '1y' },
  '5Y': { res: 'weekly', keep: 260, dailyRange: '5y' },
  '10Y': { res: 'monthly', keep: 120, dailyRange: '10y' },
};

const DAY = 86400;
/** candle.time is IST-shifted seconds, so these are IST calendar buckets */
export const weekStart = (t: number): number => {
  const day = Math.floor(t / DAY);
  const dow = (day + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  return (day - ((dow + 6) % 7)) * DAY;
};
export const monthStart = (t: number): number => {
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
};
const bucketOf = (res: Resolution, t: number) => (res === 'weekly' ? weekStart(t) : res === 'monthly' ? monthStart(t) : Math.floor(t / DAY) * DAY);

/** drop unusable rows, repair high/low, force strictly ascending unique times — Lightweight Charts throws on anything else */
export function sanitizeBars(bars: readonly Candle[]): Candle[] {
  const by = new Map<number, Candle>();
  for (const c of bars) {
    if (![c.time, c.open, c.high, c.low, c.close].every((x) => typeof x === 'number' && Number.isFinite(x)) || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) continue;
    by.set(c.time, { time: c.time, open: c.open, high: Math.max(c.high, c.open, c.close), low: Math.min(c.low, c.open, c.close), close: c.close, volume: Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0 });
  }
  return [...by.values()].sort((a, b) => a.time - b.time);
}

/** merge bars into calendar buckets: open of the first, high / low extremes, close of the last, summed volume. Bar times are snapped to the bucket start. */
export function aggregateBars(bars: readonly Candle[], res: Resolution): Candle[] {
  const out: Candle[] = [];
  for (const c of sanitizeBars(bars)) {
    const t = bucketOf(res, c.time);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else out.push({ ...c, time: t });
  }
  return out;
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
/** does the median spacing look like the requested resolution? (daily ≤ 4 d · weekly 5–9 d · monthly 25–35 d) — needs ≥ 3 bars to judge */
export function resolutionOk(bars: readonly Candle[], res: Resolution): boolean {
  if (bars.length < 3) return false;
  const gaps: number[] = [];
  for (let i = 1; i < bars.length; i++) gaps.push((bars[i].time - bars[i - 1].time) / DAY);
  const m = median(gaps);
  return res === 'daily' ? m >= 1 && m <= 4 : res === 'weekly' ? m >= 5 && m <= 9 : m >= 25 && m <= 35;
}

const trim = (bars: Candle[], keep: number) => (Number.isFinite(keep) && bars.length > keep ? bars.slice(-keep) : bars);

/** the provider's own bars if they are at the right resolution (snapped to our week / month buckets so live ticks join the last candle), else null */
export function acceptDirect(tf: Timeframe, direct: readonly Candle[]): Candle[] | null {
  const spec = RANGE_SPECS[tf];
  if (!spec) return sanitizeBars(direct);
  const clean = sanitizeBars(direct);
  if (!resolutionOk(clean, spec.res)) return null;
  return trim(spec.res === 'daily' ? clean : aggregateBars(clean, spec.res), spec.keep);
}

/** rebuild from daily bars (the guaranteed fallback) */
export function fromDaily(tf: Timeframe, daily: readonly Candle[]): Candle[] {
  const spec = RANGE_SPECS[tf];
  if (!spec) return sanitizeBars(daily);
  const clean = sanitizeBars(daily);
  return trim(spec.res === 'daily' ? clean : aggregateBars(clean, spec.res), spec.keep);
}

/** 'direct' | 'aggregated' | 'none' — what the combination of provider answers yields */
export function resolveRange(tf: Timeframe, direct: readonly Candle[], daily: readonly Candle[] | null): { bars: Candle[]; via: 'direct' | 'aggregated' | 'none' } {
  const ok = acceptDirect(tf, direct);
  if (ok && ok.length) return { bars: ok, via: 'direct' };
  if (daily && daily.length) {
    const a = fromDaily(tf, daily);
    if (a.length) return { bars: a, via: 'aggregated' };
  }
  // last resort: whatever sane bars the provider gave (e.g. a very new listing with < 3 monthly candles) — never an empty canvas if there is data
  const raw = sanitizeBars(direct);
  return raw.length ? { bars: trim(raw, RANGE_SPECS[tf]?.keep ?? Infinity), via: 'direct' } : { bars: [], via: 'none' };
}

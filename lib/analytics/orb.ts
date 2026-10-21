// Opening Range Breakout (ORB) tracker.
//   Opening range = High and Low of every 1-minute bar from 09:15 up to (not including) 09:30 IST.
//   Breakout = the first bar AFTER 09:30 that CLOSES above the range high (up) or below the range low (down).
//   Confirmed = the following bar also closes outside the same side (a one-bar poke is reported as "unconfirmed").
//   Volume ratio = breakout-bar volume ÷ average volume per bar inside the opening range.
// Candle times are IST-shifted epoch seconds (lib/market.ts IST_OFFSET), so minute-of-day = ⌊t/60⌋ mod 1440.

export interface OrbBar {
  time: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const OR_START_MIN = 9 * 60 + 15;
export const OR_END_MIN = 9 * 60 + 30;
const minuteOfDay = (t: number) => Math.floor(t / 60) % 1440;
const dayOf = (t: number) => Math.floor(t / 86400);
const hhmm = (t: number) => { const m = minuteOfDay(t); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

export type OrbState = 'forming' | 'inside' | 'above' | 'below';

export interface OrbResult {
  high: number;
  low: number;
  width: number;
  widthPct: number;
  state: OrbState;
  /** only when a bar has closed outside the range */
  breakout: { dir: 'up' | 'down'; time: string; price: number; confirmed: boolean; volumeRatio: number | null; distancePct: number } | null;
  /** latest close vs the opposite edge — how far from the range edge it is now, in % of that edge */
  lastClose: number;
  barsInRange: number;
}

/** ORB for the most recent trading day in `bars`; null when no opening-range bars exist. */
export function openingRange(bars: OrbBar[]): OrbResult | null {
  if (bars.length === 0) return null;
  const day = dayOf(bars[bars.length - 1].time);
  const today = bars.filter((b) => dayOf(b.time) === day).sort((a, b) => a.time - b.time);
  const inOr = today.filter((b) => { const m = minuteOfDay(b.time); return m >= OR_START_MIN && m < OR_END_MIN; });
  if (inOr.length === 0) return null;
  const high = Math.max(...inOr.map((b) => b.high));
  const low = Math.min(...inOr.map((b) => b.low));
  const after = today.filter((b) => minuteOfDay(b.time) >= OR_END_MIN);
  const last = today[today.length - 1];
  const avgVol = inOr.reduce((a, b) => a + b.volume, 0) / inOr.length;
  const out: OrbResult = { high, low, width: high - low, widthPct: low > 0 ? ((high - low) / low) * 100 : 0, state: after.length === 0 ? 'forming' : 'inside', breakout: null, lastClose: last.close, barsInRange: inOr.length };
  const idx = after.findIndex((b) => b.close > high || b.close < low);
  if (idx >= 0) {
    const b = after[idx];
    const dir = b.close > high ? 'up' : 'down';
    const next = after[idx + 1];
    const confirmed = !!next && (dir === 'up' ? next.close > high : next.close < low);
    out.breakout = { dir, time: hhmm(b.time), price: b.close, confirmed, volumeRatio: avgVol > 0 ? b.volume / avgVol : null, distancePct: dir === 'up' ? ((b.close - high) / high) * 100 : ((low - b.close) / low) * 100 };
  }
  if (after.length) out.state = last.close > high ? 'above' : last.close < low ? 'below' : 'inside';
  return out;
}

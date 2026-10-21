// Automated candlestick / chart pattern detector over the last 20 candles. Rule-based and descriptive — it names a shape that is present
// in the bars, it does not forecast. Every rule is stated below so it can be audited (and is unit-tested on synthetic series).
//
//   Bullish Engulfing        previous candle red, latest green, latest body fully covers the previous body (open ≤ prev close, close ≥ prev open)
//   Bearish Engulfing        mirror image
//   Resistance Breakout      latest close above the highest high of the 19 candles before it, on volume ≥ 1.2 × their average
//   Double Bottom            two pivot lows (lower than 2 candles each side) ≥ 4 bars apart, within 0.6 % of each other, with a rally ≥ 1 %
//                            between them, and the latest close above the midpoint of that rally ("confirming")
//   High Volatility Doji     latest candle body ≤ 10 % of its range while the range ≥ 1.5 × the average range of the window

export interface PBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type PatternId = 'bullEngulf' | 'bearEngulf' | 'breakout' | 'doubleBottom' | 'volDoji';
export interface Pattern {
  id: PatternId;
  label: string;
  tone: 'up' | 'down' | 'warn';
  detail: string;
}

export const PATTERN_WINDOW = 20;
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

export function detectPatterns(all: PBar[]): Pattern[] {
  const w = all.slice(-PATTERN_WINDOW);
  const out: Pattern[] = [];
  if (w.length < 5) return out;
  const last = w[w.length - 1];
  const prev = w[w.length - 2];
  const body = (b: PBar) => Math.abs(b.close - b.open);
  const range = (b: PBar) => b.high - b.low;

  if (prev.close < prev.open && last.close > last.open && last.open <= prev.close && last.close >= prev.open && body(last) > body(prev)) {
    out.push({ id: 'bullEngulf', label: '⚡ Bullish Engulfing', tone: 'up', detail: 'A green candle fully covers the previous red body — buyers took over.' });
  }
  if (prev.close > prev.open && last.close < last.open && last.open >= prev.close && last.close <= prev.open && body(last) > body(prev)) {
    out.push({ id: 'bearEngulf', label: '🔻 Bearish Engulfing', tone: 'down', detail: 'A red candle fully covers the previous green body — sellers took over.' });
  }
  if (w.length >= 20) {
    const before = w.slice(0, -1);
    const hh = Math.max(...before.map((b) => b.high));
    const av = avg(before.map((b) => b.volume));
    if (last.close > hh && (av <= 0 || last.volume >= 1.2 * av)) {
      out.push({ id: 'breakout', label: '📈 Resistance Breakout', tone: 'up', detail: `Closed above the prior ${before.length}-candle high (₹${hh.toFixed(2)}) on above-average volume.` });
    }
  }
  const lows: number[] = [];
  for (let i = 2; i < w.length - 2; i++) if (w[i].low < w[i - 1].low && w[i].low < w[i - 2].low && w[i].low <= w[i + 1].low && w[i].low <= w[i + 2].low) lows.push(i);
  for (let a = 0; a < lows.length; a++) {
    let found = false;
    for (let b = a + 1; b < lows.length; b++) {
      const i = lows[a];
      const j = lows[b];
      if (j - i < 4) continue;
      const la = w[i].low;
      const lb = w[j].low;
      if (Math.abs(la - lb) / Math.min(la, lb) > 0.006) continue;
      const peak = Math.max(...w.slice(i, j + 1).map((x) => x.high));
      const base = Math.max(la, lb);
      if ((peak - base) / base < 0.01) continue;
      if (last.close > (peak + base) / 2) { out.push({ id: 'doubleBottom', label: '🔄 Double Bottom', tone: 'up', detail: `Two lows near ₹${Math.min(la, lb).toFixed(2)}; price has recovered above the mid-point of the rally between them.` }); found = true; break; }
    }
    if (found) break;
  }
  const avgRange = avg(w.slice(0, -1).map(range));
  if (range(last) > 0 && body(last) <= 0.1 * range(last) && avgRange > 0 && range(last) >= 1.5 * avgRange) {
    out.push({ id: 'volDoji', label: '⚠️ High Volatility Doji', tone: 'warn', detail: 'Wide-range candle that closed near its open — indecision after a volatile swing.' });
  }
  return out;
}

/** 1-minute candles → N-minute candles (times are epoch seconds; buckets align to the epoch like the chart does). */
export function aggregateBars<T extends PBar & { time: number }>(bars: T[], minutes: number): (PBar & { time: number })[] {
  const sec = minutes * 60;
  const out: (PBar & { time: number })[] = [];
  for (const b of bars) {
    const t = Math.floor(b.time / sec) * sec;
    const l = out[out.length - 1];
    if (l && l.time === t) {
      l.high = Math.max(l.high, b.high);
      l.low = Math.min(l.low, b.low);
      l.close = b.close;
      l.volume += b.volume;
    } else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
  }
  return out;
}

/** Session VWAP series: cumulative Σ(typical price × volume) ÷ Σ volume, restarting on each new IST day (time = IST-shifted seconds). */
export function vwapSeries(bars: (PBar & { time: number })[]): (number | null)[] {
  let day = -1;
  let pv = 0;
  let v = 0;
  return bars.map((b) => {
    const d = Math.floor(b.time / 86400);
    if (d !== day) { day = d; pv = 0; v = 0; }
    if (b.volume > 0) { pv += ((b.high + b.low + b.close) / 3) * b.volume; v += b.volume; }
    return v > 0 ? pv / v : null;
  });
}

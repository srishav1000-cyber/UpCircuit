// Zero-dependency technical pattern scanner over daily OHLC bars. Pure functions, no network, no fitted parameters — every rule is the textbook definition,
// and every signal states the numbers it used. A pattern is a description of price action, not a prediction or advice.
export interface Bar { time: number; open: number; high: number; low: number; close: number; volume?: number }
export type Bias = 'bullish' | 'bearish' | 'neutral';
export type Group = 'Candlestick' | 'Momentum & Trend' | 'Breakout';
export interface Signal { id: string; name: string; group: Group; bias: Bias; /** index of the bar the pattern completes on */ at: number; /** 0 = latest bar */ age: number; time: number; detail: string }
export interface ScanOpts { /** how many most-recent bars may complete a pattern (default 3) */ recent?: number }

export const MIN_BARS = 60;
const body = (b: Bar) => Math.abs(b.close - b.open), range = (b: Bar) => b.high - b.low, bull = (b: Bar) => b.close > b.open, bear = (b: Bar) => b.close < b.open;
const pct = (x: number) => `${x.toFixed(2)}%`;

export function ema(v: readonly number[], n: number): (number | null)[] {
  const out: (number | null)[] = Array(v.length).fill(null); if (v.length < n) return out;
  let e = v.slice(0, n).reduce((a, x) => a + x, 0) / n; out[n - 1] = e; const k = 2 / (n + 1);
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
/** Wilder RSI; null until `n` changes exist. */
export function rsi(v: readonly number[], n = 14): (number | null)[] {
  const out: (number | null)[] = Array(v.length).fill(null); if (v.length <= n) return out;
  let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; } g /= n; l /= n;
  const val = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l)); out[n] = val();
  for (let i = n + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = val(); }
  return out;
}
/** Swing pivots: strictly higher (high) / lower (low) than `k` bars on each side. Confirmed only after k later bars exist. */
export function pivots(bars: readonly Bar[], kind: 'high' | 'low', k = 3): number[] {
  const out: number[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let ok = true; for (let j = 1; j <= k && ok; j++) ok = kind === 'high' ? bars[i].high > bars[i - j].high && bars[i].high > bars[i + j].high : bars[i].low < bars[i - j].low && bars[i].low < bars[i + j].low;
    if (ok) out.push(i);
  }
  return out;
}

type Det = (bars: readonly Bar[], i: number) => Omit<Signal, 'at' | 'age' | 'time' | 'group'> | null;
const downtrend = (bars: readonly Bar[], i: number) => i >= 5 && bars[i].close < bars[i - 5].close;

const candle: Det[] = [
  (b, i) => { const p = b[i - 1], c = b[i]; if (!p || !(bear(p) && bull(c))) return null; return c.open <= p.close && c.close >= p.open && body(c) > body(p) ? { id: 'bull-engulf', name: 'Bullish Engulfing', bias: 'bullish', detail: `Green body ${c.open.toFixed(2)}→${c.close.toFixed(2)} engulfs prior red body ${p.open.toFixed(2)}→${p.close.toFixed(2)}` } : null; },
  (b, i) => { const p = b[i - 1], c = b[i]; if (!p || !(bull(p) && bear(c))) return null; return c.open >= p.close && c.close <= p.open && body(c) > body(p) ? { id: 'bear-engulf', name: 'Bearish Engulfing', bias: 'bearish', detail: `Red body ${c.open.toFixed(2)}→${c.close.toFixed(2)} engulfs prior green body ${p.open.toFixed(2)}→${p.close.toFixed(2)}` } : null; },
  (b, i) => { const c = b[i], r = range(c); if (r <= 0 || !downtrend(b, i)) return null; const lo = Math.min(c.open, c.close) - c.low, up = c.high - Math.max(c.open, c.close), bd = Math.max(body(c), r * 0.02);
    return lo >= 2 * bd && up <= 0.3 * bd + r * 0.05 && body(c) <= r * 0.35 ? { id: 'hammer', name: 'Hammer', bias: 'bullish', detail: `Lower shadow ${(lo / bd).toFixed(1)}× the body after a 5-bar decline` } : null; },
  (b, i) => { const c = b[i], r = range(c); return r > 0 && body(c) <= r * 0.1 ? { id: 'doji', name: 'Doji', bias: 'neutral', detail: `Body is ${((body(c) / r) * 100).toFixed(0)}% of the ${r.toFixed(2)} range — indecision` } : null; },
  (b, i) => { const a = b[i - 2], m = b[i - 1], c = b[i]; if (!a || !(bear(a) && bull(c)) || body(a) < range(a) * 0.5) return null; return body(m) <= body(a) * 0.3 && Math.max(m.open, m.close) < a.close + body(a) * 0.1 && c.close > (a.open + a.close) / 2 ? { id: 'morning-star', name: 'Morning Star', bias: 'bullish', detail: `Long red, small-body pause, then green closing above the first bar's midpoint (${((a.open + a.close) / 2).toFixed(2)})` } : null; },
  (b, i) => { const a = b[i - 2], m = b[i - 1], c = b[i]; if (!a || !(bull(a) && bear(c)) || body(a) < range(a) * 0.5) return null; return body(m) <= body(a) * 0.3 && Math.min(m.open, m.close) > a.close - body(a) * 0.1 && c.close < (a.open + a.close) / 2 ? { id: 'evening-star', name: 'Evening Star', bias: 'bearish', detail: `Long green, small-body pause, then red closing below the first bar's midpoint (${((a.open + a.close) / 2).toFixed(2)})` } : null; },
];

export interface Level { px: number; touches: number }
/** Swing-pivot prices of the last 150 bars; pivots within 0.6 % cluster into one level; a level needs ≥ 2 touches. Sorted ascending. */
export function supportResistance(bars: readonly Bar[]): Level[] {
  const n = bars.length, highs = pivots(bars, 'high'), lows = pivots(bars, 'low');
  const pts = [...highs, ...lows].filter((i) => i >= n - 150).map((i) => (highs.includes(i) ? bars[i].high : bars[i].low)).sort((a, b) => a - b);
  const levels: Level[] = []; for (const p of pts) { const L = levels[levels.length - 1]; if (L && Math.abs(p / L.px - 1) <= 0.006) { L.px = (L.px * L.touches + p) / (L.touches + 1); L.touches++; } else levels.push({ px: p, touches: 1 }); }
  return levels.filter((L) => L.touches >= 2);
}

function structural(bars: readonly Bar[], recent: number): Signal[] {
  const out: Signal[] = []; const n = bars.length, last = n - 1; const closes = bars.map((b) => b.close);
  const mk = (id: string, name: string, group: Group, bias: Bias, at: number, detail: string): Signal => ({ id, name, group, bias, at, age: last - at, time: bars[at].time, detail });
  // EMA 20 / 50 crossover
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  // a cross only counts if the two EMAs are still ≥ 0.02 % apart on the latest bar (stops hairline wiggles on flat prices from reading as crosses)
  const gap = (i: number) => { const a = e20[i], b = e50[i]; return a === null || b === null ? null : (a - b) / b; };
  const gLast = gap(last);
  for (let i = Math.max(51, n - recent); i < n; i++) { const a0 = e20[i - 1], b0 = e50[i - 1], a1 = e20[i], b1 = e50[i]; if (a0 === null || b0 === null || a1 === null || b1 === null || gLast === null) continue;
    if (a0 <= b0 && a1 > b1 && gLast >= 0.0002) out.push(mk('golden', 'EMA 20/50 Golden Cross', 'Momentum & Trend', 'bullish', i, `EMA20 ${a1.toFixed(2)} crossed above EMA50 ${b1.toFixed(2)}`));
    else if (a0 >= b0 && a1 < b1 && gLast <= -0.0002) out.push(mk('death', 'EMA 20/50 Death Cross', 'Momentum & Trend', 'bearish', i, `EMA20 ${a1.toFixed(2)} crossed below EMA50 ${b1.toFixed(2)}`)); }
  // RSI divergence on the last two confirmed swing pivots (k = 3 → a pivot is confirmed 3 bars later; report if the second pivot is within the last 12 bars)
  const r = rsi(closes, 14), lows = pivots(bars, 'low'), highs = pivots(bars, 'high');
  if (lows.length >= 2) { const [p1, p2] = lows.slice(-2), a = r[p1], b = r[p2]; if (a !== null && b !== null && last - p2 <= 12 && bars[p2].low < bars[p1].low && b > a + 1) out.push(mk('rsi-bull-div', 'RSI Bullish Divergence', 'Momentum & Trend', 'bullish', p2, `Price low ${bars[p1].low.toFixed(2)}→${bars[p2].low.toFixed(2)} (lower) while RSI ${a.toFixed(1)}→${b.toFixed(1)} (higher)`)); }
  if (highs.length >= 2) { const [p1, p2] = highs.slice(-2), a = r[p1], b = r[p2]; if (a !== null && b !== null && last - p2 <= 12 && bars[p2].high > bars[p1].high && b < a - 1) out.push(mk('rsi-bear-div', 'RSI Bearish Divergence', 'Momentum & Trend', 'bearish', p2, `Price high ${bars[p1].high.toFixed(2)}→${bars[p2].high.toFixed(2)} (higher) while RSI ${a.toFixed(1)}→${b.toFixed(1)} (lower)`)); }
  // 20-day Donchian channel breakout: close beyond the prior 20 bars' high / low
  for (let i = Math.max(20, n - recent); i < n; i++) { const w = bars.slice(i - 20, i), hi = Math.max(...w.map((x) => x.high)), lo = Math.min(...w.map((x) => x.low));
    if (bars[i].close > hi) out.push(mk('brk-up', '20-day High Breakout', 'Breakout', 'bullish', i, `Close ${bars[i].close.toFixed(2)} above the prior 20-day high ${hi.toFixed(2)} (${pct((bars[i].close / hi - 1) * 100)})`));
    else if (bars[i].close < lo) out.push(mk('brk-dn', '20-day Low Breakdown', 'Breakout', 'bearish', i, `Close ${bars[i].close.toFixed(2)} below the prior 20-day low ${lo.toFixed(2)} (${pct((bars[i].close / lo - 1) * 100)})`)); }
  // Support / resistance bands: see supportResistance(); flag when the close is within 1 % of a level tested ≥ 2 times
  const c = bars[last].close, near = supportResistance(bars).filter((L) => Math.abs(c / L.px - 1) <= 0.01).sort((a, b) => Math.abs(c / a.px - 1) - Math.abs(c / b.px - 1))[0];
  if (near) { const below = c >= near.px; out.push(mk(below ? 'sr-support' : 'sr-resist', below ? 'Near Support Band' : 'Near Resistance Band', 'Breakout', below ? 'bullish' : 'bearish', last, `Close ${c.toFixed(2)} is ${pct(Math.abs(c / near.px - 1) * 100)} ${below ? 'above' : 'below'} a level at ${near.px.toFixed(2)} tested ${near.touches}×`)); }
  return out;
}

/** All detections completing within the last `recent` bars (default 3), newest first. Returns [] when there are fewer than MIN_BARS bars. */
export function scan(bars: readonly Bar[], o: ScanOpts = {}): Signal[] {
  const recent = o.recent ?? 3, n = bars.length; if (n < MIN_BARS) return [];
  const clean = bars.every((b) => [b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x) && x > 0) && b.high >= b.low); if (!clean) return [];
  const out: Signal[] = [];
  for (let i = n - recent; i < n; i++) for (const d of candle) { const s = d(bars, i); if (s) out.push({ ...s, group: 'Candlestick', at: i, age: n - 1 - i, time: bars[i].time }); }
  out.push(...structural(bars, recent));
  return out.sort((a, b) => a.age - b.age || (a.group === b.group ? 0 : a.group === 'Candlestick' ? 1 : -1));
}
export const NET_BIAS = (s: readonly Signal[]): Bias => { const x = s.reduce((a, v) => a + (v.bias === 'bullish' ? 1 : v.bias === 'bearish' ? -1 : 0), 0); return x > 0 ? 'bullish' : x < 0 ? 'bearish' : 'neutral'; };

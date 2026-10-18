import type { Holding, Quote } from './types';
import { hashStr } from './market';

/* ═══════════════ moving averages & oscillators ═══════════════ */

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** Exponential moving average series (seeded with the first value). */
export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

/** MACD(12, 26, 9): latest line, signal and histogram. */
export function macd(closes: number[]): { line: number; signal: number; hist: number } | null {
  if (closes.length < 35) return null;
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const line = e12.map((v, i) => v - e26[i]);
  const sig = emaSeries(line, 9);
  const i = line.length - 1;
  return { line: line[i], signal: sig[i], hist: line[i] - sig[i] };
}

/** Wilder's 14-period RSI over a close series. */
export function rsi14(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

/* ═══════════════ risk / return statistics ═══════════════ */

export const simpleReturns = (closes: number[]): number[] => {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i - 1] - 1);
  return r;
};

/** Annualised Sharpe from simple daily returns; rf is the annual risk-free rate (default 6.5 %). */
export function sharpe(closes: number[], rf = 0.065): number | null {
  if (closes.length < 30) return null;
  const rfd = rf / 252;
  const ex = simpleReturns(closes).map((r) => r - rfd);
  const mean = ex.reduce((a, b) => a + b, 0) / ex.length;
  const sd = Math.sqrt(ex.reduce((a, b) => a + (b - mean) ** 2, 0) / (ex.length - 1));
  // a flat series has σ ≈ 1e-20 from float noise, not exactly 0 — treat that as "undefined"
  return !Number.isFinite(sd) || sd < 1e-9 ? null : (mean / sd) * Math.sqrt(252);
}

/** Annualised growth implied by a log-linear regression on daily closes. */
export function trendGrowthYoY(closes: number[]): number | null {
  const n = closes.length;
  if (n < 30) return null;
  const y = closes.map(Math.log);
  const xm = (n - 1) / 2;
  const ym = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (y[i] - ym);
    den += (i - xm) ** 2;
  }
  return (Math.exp((num / den) * 252) - 1) * 100;
}

/** Pearson correlation r = cov(x, y) / (σx σy). Series are right-aligned to the shorter length. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(a.length - n);
  const y = b.slice(b.length - n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

/** Correlation matrix of daily simple returns for the given close series. */
export function correlationMatrix(series: Record<string, number[]>): { symbols: string[]; matrix: number[][] } {
  const symbols = Object.keys(series);
  const rets = symbols.map((s) => simpleReturns(series[s]));
  const matrix = symbols.map((_, i) => symbols.map((__, j) => (i === j ? 1 : pearson(rets[i], rets[j]))));
  return { symbols, matrix };
}

/** Herfindahl–Hirschman index on portfolio weights, 0–10 000. HHI = 10⁴ · Σ wᵢ². */
export function hhi(values: number[]): number {
  const tot = values.reduce((a, b) => a + b, 0);
  if (tot <= 0) return 0;
  return values.reduce((a, v) => a + (v / tot) ** 2, 0) * 10000;
}

/** Volume-weighted average price: Σ(P·V) / ΣV. */
export function vwap(prices: number[], volumes: number[]): number | null {
  let pv = 0;
  let v = 0;
  const n = Math.min(prices.length, volumes.length);
  for (let i = 0; i < n; i++) {
    pv += prices[i] * volumes[i];
    v += volumes[i];
  }
  return v > 0 ? pv / v : null;
}

/* ═══════════════ support / resistance & outlook ═══════════════ */

export interface Pivots {
  p: number;
  r1: number;
  r2: number;
  s1: number;
  s2: number;
}

/** Classic floor-trader pivots from the prior period's high / low / close. */
export function pivotLevels(high: number, low: number, close: number): Pivots {
  const p = (high + low + close) / 3;
  return { p, r1: 2 * p - low, r2: p + (high - low), s1: 2 * p - high, s2: p - (high - low) };
}

export type Bias = 'bull' | 'bear' | 'neutral';
export interface Signal {
  name: string;
  value: string;
  bias: Bias;
}
export interface Outlook {
  label: 'Bullish' | 'Bearish' | 'Neutral';
  /** −100 … +100 */
  score: number;
  signals: Signal[];
}

const toOutlook = (signals: Signal[]): Outlook => {
  const pts = signals.reduce((a, s) => a + (s.bias === 'bull' ? 1 : s.bias === 'bear' ? -1 : 0), 0);
  const score = Math.round((pts / signals.length) * 100);
  return { label: score >= 33 ? 'Bullish' : score <= -33 ? 'Bearish' : 'Neutral', score, signals };
};
const bias = (cond: boolean | null, neutral = false): Bias => (neutral || cond === null ? 'neutral' : cond ? 'bull' : 'bear');

/** Short-term (≈1–4 weeks): RSI, price vs 20-DMA, MACD histogram, 10-day momentum. Needs ≥35 daily closes. */
export function shortTermOutlook(closes: number[]): Outlook | null {
  const last = closes[closes.length - 1];
  const rsi = rsi14(closes);
  const s20 = sma(closes, 20);
  const m = macd(closes);
  if (rsi === null || s20 === null || m === null || closes.length < 11) return null;
  const roc = (last / closes[closes.length - 11] - 1) * 100;
  const rsiBias: Bias = rsi >= 70 ? 'bear' : rsi >= 55 ? 'bull' : rsi >= 45 ? 'neutral' : rsi > 30 ? 'bear' : 'bull';
  return toOutlook([
    { name: 'RSI (14)', value: rsi.toFixed(1) + (rsi >= 70 ? ' · overbought' : rsi <= 30 ? ' · oversold' : ''), bias: rsiBias },
    { name: 'Price vs 20-DMA', value: `${last >= s20 ? 'above' : 'below'} (${((last / s20 - 1) * 100).toFixed(1)}%)`, bias: bias(last >= s20) },
    { name: 'MACD histogram', value: m.hist.toFixed(2), bias: bias(m.hist > 0) },
    { name: '10-day momentum', value: (roc >= 0 ? '+' : '') + roc.toFixed(1) + '%', bias: Math.abs(roc) < 2 ? 'neutral' : bias(roc > 0) },
  ]);
}

/** Long-term (≈6–12 months): 50/200-DMA, price vs 200-DMA, 12-month return, trend slope, distance from 52-week high. Needs ≥200 closes. */
export function longTermOutlook(closes: number[]): Outlook | null {
  if (closes.length < 200) return null;
  const last = closes[closes.length - 1];
  const s50 = sma(closes, 50)!;
  const s200 = sma(closes, 200)!;
  const yr = closes.slice(-252);
  const ret = (last / yr[0] - 1) * 100;
  const slope = trendGrowthYoY(yr);
  const hi = Math.max(...yr);
  const offHigh = (last / hi - 1) * 100;
  return toOutlook([
    { name: '50-DMA vs 200-DMA', value: s50 >= s200 ? 'golden cross zone' : 'death cross zone', bias: bias(s50 >= s200) },
    { name: 'Price vs 200-DMA', value: `${last >= s200 ? 'above' : 'below'} (${((last / s200 - 1) * 100).toFixed(1)}%)`, bias: bias(last >= s200) },
    { name: '12-month return', value: (ret >= 0 ? '+' : '') + ret.toFixed(1) + '%', bias: Math.abs(ret) < 10 ? 'neutral' : bias(ret > 0) },
    { name: 'Trend slope (annualised)', value: slope === null ? '—' : (slope >= 0 ? '+' : '') + slope.toFixed(1) + '%', bias: slope === null || (slope > -5 && slope < 8) ? 'neutral' : bias(slope > 0) },
    { name: 'Distance from 52-wk high', value: offHigh.toFixed(1) + '%', bias: offHigh >= -10 ? 'bull' : offHigh <= -25 ? 'bear' : 'neutral' },
  ]);
}

/* ═══════════════ market structure ═══════════════ */

export interface Breadth {
  adv: number;
  dec: number;
  unch: number;
  /** Advancers ÷ Decliners */
  ratio: number;
}
export function breadth(quotes: Iterable<Quote>): Breadth {
  let adv = 0;
  let dec = 0;
  let unch = 0;
  for (const q of quotes) {
    if (q.ltp > q.prevClose) adv++;
    else if (q.ltp < q.prevClose) dec++;
    else unch++;
  }
  return { adv, dec, unch, ratio: dec === 0 ? adv : adv / dec };
}

export interface SectorStat {
  sector: string;
  pct: number; // mcap-weighted day change
  mcapCr: number;
  count: number;
  top: { symbol: string; pct: number }[];
}
export function sectorStats(quotes: Iterable<Quote>): SectorStat[] {
  const map = new Map<string, Quote[]>();
  for (const q of quotes) {
    if (q.sector === 'Others') continue;
    const arr = map.get(q.sector) ?? [];
    arr.push(q);
    map.set(q.sector, arr);
  }
  const out: SectorStat[] = [];
  map.forEach((qs, sector) => {
    const mcap = qs.reduce((a, q) => a + q.mcapCr, 0);
    const pct = qs.reduce((a, q) => a + (q.ltp / q.prevClose - 1) * 100 * q.mcapCr, 0) / mcap;
    const top = [...qs]
      .sort((a, b) => b.mcapCr - a.mcapCr)
      .slice(0, 3)
      .map((q) => ({ symbol: q.symbol, pct: (q.ltp / q.prevClose - 1) * 100 }));
    out.push({ sector, pct, mcapCr: mcap, count: qs.length, top });
  });
  return out.sort((a, b) => b.mcapCr - a.mcapCr);
}

/** Market-cap buckets (₹ crore). Approximates AMFI cut-offs; SEBI actually ranks by size (top 100 / next 150). */
export const CAP_THRESHOLDS = { large: 100_000, mid: 30_000 };
export type CapClass = 'Large' | 'Mid' | 'Small';
export const capClass = (mcapCr: number): CapClass => (mcapCr >= CAP_THRESHOLDS.large ? 'Large' : mcapCr >= CAP_THRESHOLDS.mid ? 'Mid' : 'Small');

export const dayPct = (q: Quote) => (q.ltp / q.prevClose - 1) * 100;

export function topMovers(quotes: Quote[], by: 'gainers' | 'losers' | 'volume', n = 5): Quote[] {
  const arr = [...quotes];
  if (by === 'gainers') arr.sort((a, b) => dayPct(b) - dayPct(a));
  else if (by === 'losers') arr.sort((a, b) => dayPct(a) - dayPct(b));
  else arr.sort((a, b) => b.volume * b.ltp - a.volume * a.ltp);
  return arr.slice(0, n);
}

/** Composite 0–100 risk score: volatility 40 %, concentration 30 %, weak breadth 30 %. */
export function riskScore(volPct: number | null, hhiVal: number, advRatio: number): number {
  const volS = Math.min(1, (volPct ?? 30) / 60);
  const concS = Math.min(1, hhiVal / 5000);
  const brS = 1 - Math.min(1, advRatio / 2);
  return Math.round((volS * 0.4 + concS * 0.3 + brS * 0.3) * 100);
}

/* ═══════════════ portfolio ═══════════════ */

export interface PortfolioSummary {
  invested: number;
  current: number;
  /** Σ(LTP × Qty) − Invested */
  pnl: number;
  pnlPct: number;
  dayPnl: number;
  dayPct: number;
}

export function portfolioSummary(holdings: Holding[], quoteOf: (symbol: string) => Pick<Quote, 'ltp' | 'prevClose'> | undefined): PortfolioSummary {
  let invested = 0;
  let current = 0;
  let prev = 0;
  for (const h of holdings) {
    const q = quoteOf(h.symbol);
    if (!q) continue;
    invested += h.qty * h.avg;
    current += h.qty * q.ltp;
    prev += h.qty * q.prevClose;
  }
  const pnl = current - invested;
  const dayPnl = current - prev;
  return { invested, current, pnl, pnlPct: invested > 0 ? (pnl / invested) * 100 : 0, dayPnl, dayPct: prev > 0 ? (dayPnl / prev) * 100 : 0 };
}

/* ═══════════════ intraday / order-flow (day trader) ═══════════════ */

export interface Trade {
  t: number;
  p: number;
  v: number;
}

export interface VwapBands {
  vwap: number;
  /** volume-weighted standard deviation of price around the VWAP */
  sd: number;
  upper: number;
  lower: number;
  k: number;
  n: number;
}

/** Rolling VWAP = ΣP·V/ΣV with ±k volume-weighted σ Bollinger-style bands. */
export function vwapBands(trades: Trade[], k = 2): VwapBands | null {
  let v = 0;
  let pv = 0;
  for (const t of trades) {
    v += t.v;
    pv += t.p * t.v;
  }
  if (v <= 0) return null;
  const vwap = pv / v;
  let varSum = 0;
  for (const t of trades) varSum += t.v * (t.p - vwap) ** 2;
  const sd = Math.sqrt(varSum / v);
  return { vwap, sd, upper: vwap + k * sd, lower: vwap - k * sd, k, n: trades.length };
}

export interface TickVolBucket {
  /** bucket start, epoch ms */
  t: number;
  volume: number;
  /** volume traded on upticks minus downticks (sign gives bar colour) */
  net: number;
}

/** Histogram of traded volume in `n` buckets of `bucketMs`, ending at `nowMs`. Tick direction = price change vs the previous trade. */
export function tickVolumeBuckets(trades: Trade[], nowMs: number, bucketMs = 5000, n = 36): TickVolBucket[] {
  const end = Math.floor(nowMs / bucketMs) * bucketMs + bucketMs;
  const start = end - n * bucketMs;
  const out: TickVolBucket[] = Array.from({ length: n }, (_, i) => ({ t: start + i * bucketMs, volume: 0, net: 0 }));
  let prev: number | null = null;
  for (const tr of trades) {
    const dir = prev === null ? 0 : Math.sign(tr.p - prev);
    prev = tr.p;
    if (tr.t < start || tr.t >= end) continue;
    const b = out[Math.floor((tr.t - start) / bucketMs)];
    b.volume += tr.v;
    b.net += dir * tr.v;
  }
  return out;
}

/** Intraday volatility index σ: stdev of log returns between consecutive samples, in % per sample and annualised %. */
export function intradaySigma(samples: number[], samplesPerYear: number): { perSamplePct: number; annualisedPct: number } | null {
  if (samples.length < 20) return null;
  const r: number[] = [];
  for (let i = 1; i < samples.length; i++) r.push(Math.log(samples[i] / samples[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return { perSamplePct: sd * 100, annualisedPct: sd * Math.sqrt(samplesPerYear) * 100 };
}

/* ═══════════════ institutional ═══════════════ */

/** Liquidity ratio = Turnover ÷ Market cap (both in ₹ crore), as a percentage. */
export const liquidityRatio = (turnoverCr: number, mcapCr: number): number => (mcapCr > 0 ? (turnoverCr / mcapCr) * 100 : 0);

/** Equal-weighted sector index (rebased to 100) from member close series; series are right-aligned to the shortest. */
export function sectorIndexSeries(members: number[][]): number[] {
  const valid = members.filter((m) => m.length > 2);
  if (valid.length === 0) return [];
  const n = Math.min(...valid.map((m) => m.length));
  const rets = valid.map((m) => simpleReturns(m.slice(m.length - n)));
  const out = [100];
  for (let i = 0; i < n - 1; i++) out.push(out[i] * (1 + rets.reduce((a, r) => a + r[i], 0) / rets.length));
  return out;
}

/** Sharpe = (Rp − Rf) / σ on a daily value series — the same estimator as `sharpe`, exposed with its parts. */
export function sharpeParts(values: number[], rf = 0.065): { sharpe: number; annReturnPct: number; annVolPct: number } | null {
  if (values.length < 30) return null;
  const r = simpleReturns(values);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
  if (!Number.isFinite(sd) || sd < 1e-9) return null;
  const rp = mean * 252;
  const vol = sd * Math.sqrt(252);
  return { sharpe: (rp - rf) / vol, annReturnPct: rp * 100, annVolPct: vol * 100 };
}

/* ═══════════════ portfolio: series, risk, diversification ═══════════════ */

/** Σ qtyᵢ · closeᵢ[t] over the common trailing window of all holdings. */
export function portfolioValueSeries(closes: number[][], qtys: number[]): number[] {
  if (closes.length === 0) return [];
  const n = Math.min(...closes.map((c) => c.length));
  const out: number[] = [];
  for (let t = 0; t < n; t++) {
    let v = 0;
    for (let i = 0; i < closes.length; i++) v += qtys[i] * closes[i][closes[i].length - n + t];
    out.push(v);
  }
  return out;
}

/** Rebase a series to 100 and return the cumulative return in % at each point. */
export const cumulativeReturnPct = (series: number[]): number[] => (series.length ? series.map((v) => (v / series[0] - 1) * 100) : []);

/** Weighted portfolio risk 0–100: Σ wᵢ·σᵢ (annualised vol) with 60 % vol ↔ 100. Weights are normalised. */
export function weightedRiskScore(items: { weight: number; volPct: number }[]): { score: number; weightedVolPct: number } {
  const tot = items.reduce((a, i) => a + i.weight, 0);
  if (tot <= 0) return { score: 0, weightedVolPct: 0 };
  const wv = items.reduce((a, i) => a + (i.weight / tot) * i.volPct, 0);
  return { score: Math.round(Math.min(1, wv / 60) * 100), weightedVolPct: wv };
}

/** Annualised volatility (%) of a daily close series. */
export function annualVolPct(closes: number[]): number {
  const r = simpleReturns(closes);
  if (r.length < 5) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100;
}

export interface DivMonth {
  /** 0 = the current month */
  offset: number;
  label: string;
  amount: number;
  parts: { symbol: string; amount: number }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Expected dividend income for the next 12 months. SIMULATED: annual income = value × yield, split into 1, 2 or 4
 * payouts whose months are derived deterministically from the symbol (real ex-dates need a corporate-actions feed).
 */
export function dividendForecast(rows: { symbol: string; value: number; yieldPct: number }[], monthIndex: number): DivMonth[] {
  const out: DivMonth[] = Array.from({ length: 12 }, (_, i) => ({ offset: i, label: MONTHS[(monthIndex + i) % 12], amount: 0, parts: [] }));
  for (const r of rows) {
    const annual = (r.value * r.yieldPct) / 100;
    if (annual <= 0) continue;
    const h = hashStr(r.symbol + ':div');
    const freq = r.yieldPct >= 2.5 ? 4 : h % 3 === 0 ? 1 : 2;
    const step = 12 / freq;
    const first = h % Math.round(step);
    for (let k = 0; k < freq; k++) {
      const m = (first + Math.round(k * step)) % 12;
      const amt = annual / freq;
      out[m].amount += amt;
      out[m].parts.push({ symbol: r.symbol, amount: amt });
    }
  }
  return out;
}

export interface DiagInput {
  symbol: string;
  sector: string;
  value: number;
  invested: number;
}

export interface RebalanceAdvice {
  kind: 'trim' | 'add' | 'diversify' | 'ok';
  title: string;
  detail: string;
}

export interface PortfolioDiagnostics {
  total: number;
  count: number;
  weights: { symbol: string; sector: string; pct: number }[];
  sectors: { sector: string; pct: number }[];
  /** position-level HHI (0–10 000) and the number of equal-sized positions it equals */
  hhi: number;
  effectiveN: number;
  sectorHhi: number;
  top1Pct: number;
  top3Pct: number;
  concentration: 'Low' | 'Moderate' | 'High';
  /** 0–100 heuristic: 40 % position spread, 35 % sector spread, 25 % number of holdings (15+ = full marks) */
  diversification: number;
  diversificationLabel: 'Poor' | 'Fair' | 'Good' | 'Excellent';
  flags: string[];
  advice: RebalanceAdvice[];
}

const CORE_SECTORS = ['Banking', 'IT', 'FMCG', 'Pharma', 'Energy', 'Auto', 'Financials', 'Metals', 'Consumer'];

/**
 * Concentration + diversification diagnostics from current market values.
 * Thresholds follow the usual HHI convention (1 500 / 2 500) and common single-name / sector caps (20 % / 35 %).
 * Educational heuristics only — not personalised investment advice.
 */
export function portfolioDiagnostics(rows: DiagInput[], universeSectors: string[] = []): PortfolioDiagnostics | null {
  const live = rows.filter((r) => r.value > 0);
  const total = live.reduce((a, r) => a + r.value, 0);
  if (live.length === 0 || total <= 0) return null;

  const weights = live.map((r) => ({ symbol: r.symbol, sector: r.sector, pct: (r.value / total) * 100 })).sort((a, b) => b.pct - a.pct);
  const secMap = new Map<string, number>();
  weights.forEach((w) => secMap.set(w.sector, (secMap.get(w.sector) ?? 0) + w.pct));
  const sectors = Array.from(secMap, ([sector, pct]) => ({ sector, pct })).sort((a, b) => b.pct - a.pct);

  const n = live.length;
  const h = weights.reduce((a, w) => a + (w.pct / 100) ** 2, 0);
  const hs = sectors.reduce((a, s) => a + (s.pct / 100) ** 2, 0);
  const posDiv = n < 2 ? 0 : Math.max(0, Math.min(1, 1 - (h - 1 / n) / (1 - 1 / n)));
  const secDiv = Math.max(0, Math.min(1, (1 - hs) / (1 - 1 / 8)));
  const diversification = Math.round(100 * (0.4 * posDiv + 0.35 * secDiv + 0.25 * Math.min(1, n / 15)));
  const top1Pct = weights[0].pct;
  const top3Pct = weights.slice(0, 3).reduce((a, w) => a + w.pct, 0);
  const hhiVal = h * 10000;
  const concentration: PortfolioDiagnostics['concentration'] = top1Pct > 25 || hhiVal > 2500 ? 'High' : top1Pct > 15 || hhiVal > 1500 ? 'Moderate' : 'Low';

  const flags: string[] = [];
  if (top1Pct > 20) flags.push(`${weights[0].symbol} is ${top1Pct.toFixed(1)}% of the portfolio`);
  if (sectors[0] && sectors[0].pct > 35) flags.push(`${sectors[0].sector} is ${sectors[0].pct.toFixed(1)}% of the portfolio`);
  if (n < 5) flags.push(`only ${n} holding${n === 1 ? '' : 's'}`);
  if (top3Pct > 70 && n > 3) flags.push(`top 3 holdings are ${top3Pct.toFixed(0)}%`);

  const advice: RebalanceAdvice[] = [];
  for (const w of weights.filter((x) => x.pct > 20)) {
    const excess = ((w.pct - 15) / 100) * total;
    advice.push({ kind: 'trim', title: `Trim ${w.symbol}`, detail: `Weight ${w.pct.toFixed(1)}% vs a common 15–20% single-stock ceiling; bringing it to ~15% would free about ₹${Math.round(excess).toLocaleString('en-IN')}.` });
  }
  for (const s of sectors.filter((x) => x.pct > 35)) {
    advice.push({ kind: 'trim', title: `Reduce ${s.sector} exposure`, detail: `${s.pct.toFixed(1)}% in one sector; consider keeping any single sector near or below ~30–35%.` });
  }
  const held = new Set(sectors.map((s) => s.sector));
  const missing = CORE_SECTORS.filter((s) => !held.has(s) && (universeSectors.length === 0 || universeSectors.includes(s))).slice(0, 3);
  if (missing.length && (n >= 3 || sectors.length < 4)) {
    advice.push({ kind: 'add', title: 'Add uncorrelated sectors', detail: `No exposure to ${missing.join(', ')}. Spreading across more sectors usually lowers single-theme risk.` });
  }
  if (n < 8) advice.push({ kind: 'diversify', title: 'Hold more names', detail: `${n} position${n === 1 ? '' : 's'} leaves the portfolio exposed to company-specific events; 10–15 reasonably sized positions is a common range.` });
  if (advice.length === 0) advice.push({ kind: 'ok', title: 'No rebalancing flags', detail: 'Position and sector weights are within common guidelines.' });

  return {
    total,
    count: n,
    weights,
    sectors,
    hhi: hhiVal,
    effectiveN: hhiVal > 0 ? 10000 / hhiVal : n,
    sectorHhi: hs * 10000,
    top1Pct,
    top3Pct,
    concentration,
    diversification,
    diversificationLabel: diversification >= 75 ? 'Excellent' : diversification >= 55 ? 'Good' : diversification >= 35 ? 'Fair' : 'Poor',
    flags,
    advice,
  };
}

// Chart overlays: EMA 20 / EMA 50, session VWAP and Wilder RSI(14).
//
// Two forms of the same maths:
//   • *Full series* (emaFull / vwapFull / rsiFull) — computed once when bars load or an indicator is switched on.
//   • `LiveIndicators` — O(1) state machine: committed state through the previous bar + the forming bar. Every SmartAPI tick re-evaluates only the
//     last bar, so the overlays follow the stream without recomputing history (verified equal to the full series in `npm test`).
import type { Candle } from './types';
import { rsiSeries } from './analytics/rsi';

export const INDICATOR_COLORS = { ema20: '#f59e0b', ema50: '#8b5cf6', vwap: '#38bdf8', rsi: '#14b8a6' } as const;
export type IndicatorId = keyof typeof INDICATOR_COLORS;
export interface IndicatorValues { ema20: number | null; ema50: number | null; vwap: number | null; rsi: number | null }

/** candle.time is IST-shifted seconds, so a trading session (calendar day) is floor(time / 86400) */
export const sessionDay = (time: number): number => Math.floor(time / 86400);
const typical = (b: Candle) => (b.high + b.low + b.close) / 3;

/* ── EMA (seeded with the SMA of the first `period` closes, k = 2 ÷ (period + 1)) ── */
interface EmaS { n: number; sum: number; ema: number | null }
const emaStep = (s: EmaS, close: number, period: number): EmaS => {
  if (s.ema !== null) return { n: s.n + 1, sum: s.sum, ema: s.ema + (2 / (period + 1)) * (close - s.ema) };
  const sum = s.sum + close;
  const n = s.n + 1;
  return { n, sum, ema: n >= period ? sum / period : null };
};

/* ── Wilder RSI ── */
interface RsiS { prev: number | null; changes: number; sumG: number; sumL: number; avgG: number; avgL: number }
const rsiStep = (s: RsiS, close: number, period: number): RsiS => {
  if (s.prev === null) return { ...s, prev: close };
  const d = close - s.prev;
  const g = Math.max(d, 0);
  const l = Math.max(-d, 0);
  const changes = s.changes + 1;
  if (changes < period) return { prev: close, changes, sumG: s.sumG + g, sumL: s.sumL + l, avgG: 0, avgL: 0 };
  if (changes === period) return { prev: close, changes, sumG: 0, sumL: 0, avgG: (s.sumG + g) / period, avgL: (s.sumL + l) / period };
  return { prev: close, changes, sumG: 0, sumL: 0, avgG: (s.avgG * (period - 1) + g) / period, avgL: (s.avgL * (period - 1) + l) / period };
};
const rsiVal = (s: RsiS, period: number): number | null => (s.changes < period ? null : s.avgL === 0 ? (s.avgG === 0 ? 50 : 100) : 100 - 100 / (1 + s.avgG / s.avgL));

/* ── session VWAP: Σ(typical × volume) ÷ Σ volume, restarting every IST trading day ── */
interface VwapS { day: number; pv: number; v: number }
const vwapStep = (s: VwapS, b: Candle): VwapS => {
  const d = sessionDay(b.time);
  const base = d === s.day ? s : { day: d, pv: 0, v: 0 };
  return { day: d, pv: base.pv + typical(b) * b.volume, v: base.v + b.volume };
};
const vwapVal = (s: VwapS): number | null => (s.v > 0 ? s.pv / s.v : null);

/* ═══════════════ full series (aligned to `bars`, null where undefined) ═══════════════ */
export function emaFull(closes: number[], period: number): (number | null)[] {
  let s: EmaS = { n: 0, sum: 0, ema: null };
  return closes.map((c) => ((s = emaStep(s, c, period)), s.ema));
}
export function vwapFull(bars: Candle[]): (number | null)[] {
  let s: VwapS = { day: -1, pv: 0, v: 0 };
  return bars.map((b) => ((s = vwapStep(s, b)), vwapVal(s)));
}
export const rsiFull = (closes: number[], period = 14): (number | null)[] => rsiSeries(closes, period);

/** line-series points (nulls dropped) */
export const toPoints = (bars: Candle[], values: (number | null)[]): { time: number; value: number }[] => {
  const out: { time: number; value: number }[] = [];
  for (let i = 0; i < bars.length; i++) { const v = values[i]; if (v !== null && v !== undefined && Number.isFinite(v)) out.push({ time: bars[i].time, value: v }); }
  return out;
};

/** VWAP is a session measure: meaningful only for intraday bars that carry volume */
export const vwapAvailable = (intraday: boolean, hasVolume: boolean): boolean => intraday && hasVolume;

/* ═══════════════ incremental engine ═══════════════ */
interface Committed { e20: EmaS; e50: EmaS; r: RsiS; w: VwapS }
const fresh = (): Committed => ({ e20: { n: 0, sum: 0, ema: null }, e50: { n: 0, sum: 0, ema: null }, r: { prev: null, changes: 0, sumG: 0, sumL: 0, avgG: 0, avgL: 0 }, w: { day: -1, pv: 0, v: 0 } });
const advance = (c: Committed, b: Candle): Committed => ({ e20: emaStep(c.e20, b.close, 20), e50: emaStep(c.e50, b.close, 50), r: rsiStep(c.r, b.close, 14), w: vwapStep(c.w, b) });

export class LiveIndicators {
  private committed: Committed = fresh();
  private last: Candle | null = null;

  /** seed with the loaded history; the final bar is treated as the one still forming */
  constructor(bars: Candle[] = []) {
    for (let i = 0; i < bars.length - 1; i++) this.committed = advance(this.committed, bars[i]);
    this.last = bars.length ? bars[bars.length - 1] : null;
  }

  /** the forming bar changed (isNew = a new bar opened: the previous one is final) → values for the forming bar only, O(1) */
  push(bar: Candle, isNew: boolean): IndicatorValues {
    if (isNew && this.last) this.committed = advance(this.committed, this.last);
    this.last = bar;
    return this.values();
  }

  values(): IndicatorValues {
    const b = this.last;
    if (!b) return { ema20: null, ema50: null, vwap: null, rsi: null };
    const c = this.committed;
    return { ema20: emaStep(c.e20, b.close, 20).ema, ema50: emaStep(c.e50, b.close, 50).ema, vwap: vwapVal(vwapStep(c.w, b)), rsi: rsiVal(rsiStep(c.r, b.close, 14), 14) };
  }
}

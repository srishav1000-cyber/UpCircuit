// Back-test of the circuit-proximity predictor on DAILY bars (no fitting: the rule is the one the terminal shows — within `nearPct` of the inferred 5/10/20 % band).
//   signal on day i  : close_i is within nearPct of the next un-reached band b on its side (b = smallest of 5/10/20 ≥ |move|), strictly below the limit
//   outcome on day i+1: the stock TOUCHES the same-side limit again (high ≥ close_i·(1+b%) for upper, low ≤ close_i·(1−b%) for lower); "lock" = it also CLOSES at it
//   baseline         : the same touch event over ALL stock-days (unconditional) → lift = precision ÷ baseline
// Limits: daily bars hide intraday proximity; the real band of a stock (2/5/10/20 %) is inferred, not known; touching ≠ halting.
import type { Candle } from './types';

export const BANDS = [5, 10, 20] as const;
export interface BtOpts { nearPct?: number; tolPct?: number; minSignals?: number }
export interface BandStat { band: number; signals: number; hits: number; locks: number; precision: number | null; baseline: number | null; lift: number | null }
export interface BtResult { symbols: number; days: number; signals: number; hits: number; locks: number; precision: number | null; baseline: number | null; lift: number | null; byBand: BandStat[]; enough: boolean }

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
export function backtest(series: Record<string, readonly Candle[]>, o: BtOpts = {}): BtResult {
  const near = o.nearPct ?? 1.5, tol = o.tolPct ?? 0.05, minSignals = o.minSignals ?? 30;
  const sig = new Map<number, { s: number; h: number; l: number }>(), base = new Map<number, { n: number; h: number }>();
  for (const b of BANDS) { sig.set(b, { s: 0, h: 0, l: 0 }); base.set(b, { n: 0, h: 0 }); }
  let days = 0;
  for (const bars of Object.values(series)) {
    for (let i = 1; i < bars.length - 1; i++) {
      const prev = bars[i - 1], cur = bars[i], nxt = bars[i + 1];
      if (!(prev.close > 0 && cur.close > 0 && nxt.high > 0)) continue;
      days++;
      // unconditional baseline: does the NEXT day touch +b % / −b % from today's close?
      for (const b of BANDS) {
        const bs = base.get(b)!;
        bs.n += 2; // upper and lower side
        if (nxt.high >= cur.close * (1 + (b - tol) / 100)) bs.h++;
        if (nxt.low <= cur.close * (1 - (b - tol) / 100)) bs.h++;
      }
      const move = (cur.close / prev.close - 1) * 100, upper = move >= 0;
      const band = BANDS.find((b) => b >= Math.abs(move) - 1e-9);
      if (!band || Math.abs(move) < 1) continue;
      const limit = prev.close * (1 + (upper ? band : -band) / 100);
      const prox = upper ? ((limit - cur.close) / limit) * 100 : ((cur.close - limit) / limit) * 100;
      if (!(prox > 0.005 && prox <= near)) continue;
      const st = sig.get(band)!; st.s++;
      const lim2 = cur.close * (1 + (upper ? band - tol : -(band - tol)) / 100);
      const touched = upper ? nxt.high >= lim2 : nxt.low <= lim2;
      if (touched) {
        st.h++;
        if (upper ? nxt.close >= lim2 : nxt.close <= lim2) st.l++;
      }
    }
  }
  const byBand: BandStat[] = BANDS.map((b) => {
    const s = sig.get(b)!, bs = base.get(b)!;
    const precision = ratio(s.h, s.s), baseline = ratio(bs.h, bs.n);
    return { band: b, signals: s.s, hits: s.h, locks: s.l, precision, baseline, lift: precision !== null && baseline ? precision / baseline : null };
  });
  const signals = byBand.reduce((a, x) => a + x.signals, 0), hits = byBand.reduce((a, x) => a + x.hits, 0), locks = byBand.reduce((a, x) => a + x.locks, 0);
  const bn = [...base.values()].reduce((a, x) => a + x.n, 0), bh = [...base.values()].reduce((a, x) => a + x.h, 0);
  const precision = ratio(hits, signals), baseline = ratio(bh, bn);
  return { symbols: Object.keys(series).length, days, signals, hits, locks, precision, baseline, lift: precision !== null && baseline ? precision / baseline : null, byBand, enough: signals >= minSignals };
}

// Weighted-volatility risk exposure and historical Value-at-Risk.
//
// Risk exposure score  = Σ wᵢ·σᵢ  (annualised 1Y daily volatility, weights normalised), 60 % weighted vol ↔ 100.
// Historical VaR(c)    = −(the (1−c) empirical quantile of daily portfolio returns): with n returns sorted ascending and
//                        k = ⌈n·(1−c)⌉, VaR = −r₍ₖ₎. "On 95 % of days the loss should not exceed VaR."
// Expected shortfall   = −mean of the k worst returns (the average loss on the days at or beyond VaR), so ES ≥ VaR.
// One-day horizon, no distribution assumed, current holdings back-cast over real price history (no trading, no costs).

import { simpleReturns } from './correlation';

export const VAR_CONFIDENCE = 0.95;
export const VAR_MIN_OBS = 60;

/** Annualised volatility (%) of a daily close series. */
export function annualVolPct(closes: number[]): number {
  const r = simpleReturns(closes);
  if (r.length < 5) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100;
}

/** Weighted portfolio risk 0–100: Σ wᵢ·σᵢ (annualised vol) with 60 % vol ↔ 100. Weights are normalised. */
export function weightedRiskScore(items: { weight: number; volPct: number }[]): { score: number; weightedVolPct: number } {
  const tot = items.reduce((a, i) => a + i.weight, 0);
  if (tot <= 0) return { score: 0, weightedVolPct: 0 };
  const wv = items.reduce((a, i) => a + (i.weight / tot) * i.volPct, 0);
  return { score: Math.round(Math.min(1, wv / 60) * 100), weightedVolPct: wv };
}

export interface VarResult {
  /** VaR as a positive loss fraction (0.021 = 2.1 %) */
  varPct: number;
  /** Expected shortfall as a positive loss fraction, ≥ varPct */
  esPct: number;
  confidence: number;
  /** return observations used */
  n: number;
  /** how many tail observations ES averages */
  tail: number;
}

/** Historical VaR and ES from daily returns. Fewer than `VAR_MIN_OBS` returns → null. Losses are positive; a risk-free tail floors at 0. */
export function historicalVar(returns: number[], confidence = VAR_CONFIDENCE): VarResult | null {
  const r = returns.filter((x) => Number.isFinite(x));
  if (r.length < VAR_MIN_OBS || !(confidence > 0 && confidence < 1)) return null;
  const sorted = [...r].sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(sorted.length * (1 - confidence) - 1e-9)); // epsilon: 100 × (1 − 0.95) is 5.000000000000004 in floats
  const varPct = Math.max(0, -sorted[k - 1]);
  const es = Math.max(0, -(sorted.slice(0, k).reduce((a, b) => a + b, 0) / k));
  return { varPct, esPct: Math.max(es, varPct), confidence, n: sorted.length, tail: k };
}

/** Daily returns of the holdings' combined value (qty × close), over the shortest common history. */
export function portfolioReturns(closes: number[][], qtys: number[]): number[] {
  if (closes.length === 0) return [];
  const n = Math.min(...closes.map((c) => c.length));
  if (n < 2) return [];
  const value: number[] = [];
  for (let t = 0; t < n; t++) {
    let v = 0;
    for (let i = 0; i < closes.length; i++) v += (qtys[i] ?? 0) * closes[i][closes[i].length - n + t];
    value.push(v);
  }
  return simpleReturns(value).filter((x) => Number.isFinite(x));
}

/** ₹ loss for a portfolio of `value` rupees. */
export const varRupees = (v: VarResult, value: number) => ({ var: v.varPct * value, es: v.esPct * value });

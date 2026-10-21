// Peer comparison: quartile ranks and cross-sectional valuation percentile / z-score.
//
// Quartile rank: peers with a real value are ranked best → worst ("best" = lower for P/E, debt/equity, volatility; higher for ROE, yield,
// 1Y return, Sharpe). Quartile 1 = best 25 %, 4 = worst 25 %: Q = ⌈4 · rank ÷ n⌉, only when ≥ 4 peers have a value (fewer → rank only).
// Missing values (null) are excluded, never imputed.
// Percentile (peer-relative) = share of OTHER peers with a lower value, in %. z = (x − mean) ÷ sd of the peer set.
// Own-history P/E percentile is NOT possible: the fundamentals provider gives today's P/E only, so valuation is judged against peers.

export const MIN_FOR_QUARTILE = 4;
export type Better = 'higher' | 'lower';

export interface Ranked {
  symbol: string;
  value: number | null;
  rank: number | null;
  of: number;
  quartile: 1 | 2 | 3 | 4 | null;
}

export function quartileRanks(rows: { symbol: string; value: number | null }[], better: Better): Ranked[] {
  const valid = rows.filter((r) => typeof r.value === 'number' && Number.isFinite(r.value)) as { symbol: string; value: number }[];
  const sorted = [...valid].sort((a, b) => (better === 'higher' ? b.value - a.value : a.value - b.value));
  const n = sorted.length;
  return rows.map((r) => {
    const i = sorted.findIndex((s) => s.symbol === r.symbol);
    if (i < 0) return { symbol: r.symbol, value: null, rank: null, of: n, quartile: null };
    // ties share the best rank among equal values
    const rank = sorted.findIndex((s) => s.value === sorted[i].value) + 1;
    return { symbol: r.symbol, value: r.value, rank, of: n, quartile: n >= MIN_FOR_QUARTILE ? (Math.min(4, Math.ceil((4 * rank) / n)) as 1 | 2 | 3 | 4) : null };
  });
}

export interface PeerStat {
  n: number;
  mean: number;
  sd: number;
  z: number | null;
  /** share of the other peers with a strictly lower value, 0–100; null with < 2 peers */
  percentile: number | null;
}

export function peerStat(values: number[], x: number): PeerStat | null {
  const v = values.filter(Number.isFinite);
  if (v.length < 2 || !Number.isFinite(x)) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
  const lower = v.filter((y) => y < x).length;
  const denom = v.length - 1;
  return { n: v.length, mean, sd, z: sd > 1e-12 ? (x - mean) / sd : null, percentile: denom > 0 ? (lower / denom) * 100 : null };
}

export const QUARTILE_LABEL: Record<1 | 2 | 3 | 4, string> = { 1: 'Q1 best', 2: 'Q2', 3: 'Q3', 4: 'Q4 worst' };

/** Price z-score and percentile vs its own 1Y daily closes (the one own-history valuation signal we really have). */
export function ownPriceStat(closes: number[], price: number): { z: number | null; percentile: number; n: number } | null {
  const c = closes.filter(Number.isFinite);
  if (c.length < 30) return null;
  const mean = c.reduce((a, b) => a + b, 0) / c.length;
  const sd = Math.sqrt(c.reduce((a, b) => a + (b - mean) ** 2, 0) / (c.length - 1));
  return { z: sd > 1e-12 ? (price - mean) / sd : null, percentile: (c.filter((y) => y < price).length / c.length) * 100, n: c.length };
}

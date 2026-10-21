// Tick velocity and volume surge z-score.
//   z = (mean of the most recent k buckets − mean of the baseline buckets) ÷ sd of the baseline buckets
// Baseline = every bucket before the recent ones (needs ≥ 8 and a non-zero spread, otherwise null / "warming up").
// Live feed: buckets are 10-second windows of trades (count → tick velocity, Σ volume → volume surge).
// Without the live feed the "trades" are real 1-minute bars, so only volume is available (one value per minute).

export interface TradeLike {
  t: number;
  v: number;
}

export interface Buckets {
  counts: number[];
  volumes: number[];
}

/** Trades → fixed-width buckets ending at `endMs` (oldest first, `n` buckets). */
export function bucketTrades(trades: TradeLike[], endMs: number, bucketMs: number, n: number): Buckets {
  const counts = Array(n).fill(0);
  const volumes = Array(n).fill(0);
  const start = endMs - bucketMs * n;
  for (const tr of trades) {
    if (tr.t < start || tr.t > endMs) continue;
    const i = Math.min(n - 1, Math.floor((tr.t - start) / bucketMs));
    counts[i] += 1;
    volumes[i] += tr.v;
  }
  return { counts, volumes };
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

export const MIN_BASELINE = 8;

/** z-score of the last `recent` values against all earlier ones. null when the baseline is too short or has no spread. */
export function surgeZ(series: number[], recent = 3): { z: number; recent: number; baseline: number } | null {
  if (series.length < recent + MIN_BASELINE) return null;
  const base = series.slice(0, series.length - recent);
  const cur = series.slice(series.length - recent);
  const m = mean(base);
  const sd = Math.sqrt(base.reduce((a, v) => a + (v - m) ** 2, 0) / (base.length - 1));
  if (!(sd > 1e-12)) return null;
  const r = mean(cur);
  return { z: (r - m) / sd, recent: r, baseline: m };
}

export type SurgeLevel = 'quiet' | 'normal' | 'elevated' | 'surge' | 'extreme';
export function surgeLevel(z: number): SurgeLevel {
  return z >= 3 ? 'extreme' : z >= 2 ? 'surge' : z >= 1 ? 'elevated' : z <= -1 ? 'quiet' : 'normal';
}
export const SURGE_LABEL: Record<SurgeLevel, string> = { quiet: 'Quieter than usual', normal: 'Normal pace', elevated: 'Elevated', surge: 'Surge', extreme: 'Extreme surge' };

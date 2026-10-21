// Drawdown and recovery.
//   Peak(t)      = max of the value series up to t
//   Drawdown(t)  = value(t) ÷ Peak(t) − 1          (≤ 0)
//   Max drawdown = the most negative Drawdown
// An episode starts when value falls below its prior peak and ends when a NEW peak is reached (recovered) or the series ends (ongoing).
// Only episodes at least `minDepthPct` deep are listed. Days = trading-day bars in the series.

export interface DrawdownEpisode {
  peakIdx: number;
  troughIdx: number;
  /** index where the prior peak was regained; null = still underwater */
  recoveryIdx: number | null;
  depthPct: number;
  daysToTrough: number;
  /** trough → recovery, null while ongoing */
  daysToRecover: number | null;
}

export function drawdownSeries(values: number[]): number[] {
  let peak = -Infinity;
  return values.map((v) => {
    if (v > peak) peak = v;
    return peak > 0 ? (v / peak - 1) * 100 : 0;
  });
}

export function drawdownEpisodes(values: number[], minDepthPct = 2): DrawdownEpisode[] {
  const out: DrawdownEpisode[] = [];
  if (values.length < 2) return out;
  let peakIdx = 0;
  let troughIdx = 0;
  let inDd = false;
  const close = (rec: number | null) => {
    const depth = (values[troughIdx] / values[peakIdx] - 1) * 100;
    if (-depth >= minDepthPct) out.push({ peakIdx, troughIdx, recoveryIdx: rec, depthPct: depth, daysToTrough: troughIdx - peakIdx, daysToRecover: rec === null ? null : rec - troughIdx });
  };
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= values[peakIdx]) {
      if (inDd) close(i);
      inDd = false;
      peakIdx = i;
      troughIdx = i;
    } else {
      inDd = true;
      if (values[i] < values[troughIdx] || troughIdx === peakIdx) troughIdx = i;
    }
  }
  if (inDd) close(null);
  return out;
}

export interface DrawdownSummary {
  currentPct: number;
  maxPct: number;
  /** longest recovery (trough → recovery) among recovered episodes */
  longestRecoveryDays: number | null;
  episodes: DrawdownEpisode[];
  underwaterDays: number;
}

export function summariseDrawdown(values: number[], minDepthPct = 2): DrawdownSummary | null {
  if (values.length < 30) return null;
  const dd = drawdownSeries(values);
  const eps = drawdownEpisodes(values, minDepthPct);
  const rec = eps.filter((e) => e.daysToRecover !== null).map((e) => e.daysToRecover as number);
  let uw = 0;
  for (let i = dd.length - 1; i >= 0 && dd[i] < 0; i--) uw++;
  return { currentPct: dd[dd.length - 1], maxPct: Math.min(...dd), longestRecoveryDays: rec.length ? Math.max(...rec) : null, episodes: eps, underwaterDays: uw };
}

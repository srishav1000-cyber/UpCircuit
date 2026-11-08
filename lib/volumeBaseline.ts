// Volume baseline for the volume_surge rule: the TYPICAL FULL-DAY volume of a stock = median of its last ≤ 20 completed sessions.
// "Surge" is then today's cumulative volume ÷ that baseline. Deliberately NOT time-of-day adjusted: Indian cash-market volume is front-loaded, so
// a linear "expected so far" curve would fire on ordinary mornings; a full-day multiple is slower to fire but never lies about the open.
export const BASELINE_SESSIONS = 20;
export const MIN_BASELINE_SESSIONS = 10;

export type BaselineStatus = 'ok' | 'insufficient' | 'unavailable';
export interface BaselineResult { medianVolume: number | null; sessions: number; status: BaselineStatus }

/** IST calendar day number of an epoch-ms instant */
export const istDayOf = (ms: number): number => Math.floor((ms / 1000 + 19800) / 86400);

/** bars: daily candles with IST-shifted `time` (seconds) as produced by lib/yahooData.parseBars. The still-forming session (today, IST) is excluded. */
export function computeBaseline(bars: { time: number; volume: number }[] | null | undefined, nowMs: number): BaselineResult {
  if (!bars || !bars.length) return { medianVolume: null, sessions: 0, status: 'unavailable' };
  const today = istDayOf(nowMs);
  const done = bars
    .filter((b) => Number.isFinite(b.volume) && b.volume > 0 && Math.floor(b.time / 86400) < today)   // zero volume = holiday / missing row, not a quiet day
    .sort((x, y) => x.time - y.time)
    .slice(-BASELINE_SESSIONS);
  if (done.length < MIN_BASELINE_SESSIONS) return { medianVolume: null, sessions: done.length, status: 'insufficient' };
  const v = done.map((b) => b.volume).sort((x, y) => x - y);
  const mid = v.length >> 1;
  return { medianVolume: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, sessions: done.length, status: 'ok' };
}

export const volumeMultiple = (volume: number, baseline: number | null | undefined): number | null => (baseline && baseline > 0 && volume >= 0 ? volume / baseline : null);

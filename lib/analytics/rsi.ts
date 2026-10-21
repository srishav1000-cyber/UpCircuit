// Wilder's Relative Strength Index. RSI = 100 − 100 / (1 + RS), RS = avg gain ÷ avg loss.
// First averages are simple means of the first `period` changes; afterwards avg = (prev × (period − 1) + current) ÷ period.

export const RSI_OVERSOLD = 30;
export const RSI_OVERBOUGHT = 70;

export type RsiZone = 'oversold' | 'neutral' | 'overbought';

/** RSI value for every bar from index `period` onwards (earlier bars have no value → null). */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (period < 1 || closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const rsiOf = () => (avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL));
  out[period] = rsiOf();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsiOf();
  }
  return out;
}

/** Latest 14-period (default) RSI, or null with ≤ `period` closes. A perfectly flat series reads 50 (no gains, no losses). */
export function rsi14(closes: number[], period = 14): number | null {
  const s = rsiSeries(closes, period);
  return s.length ? s[s.length - 1] : null;
}

export function rsiZone(v: number | null): RsiZone | null {
  if (v === null) return null;
  return v >= RSI_OVERBOUGHT ? 'overbought' : v <= RSI_OVERSOLD ? 'oversold' : 'neutral';
}

export const RSI_LABEL: Record<RsiZone, string> = { oversold: 'Oversold', neutral: 'Neutral', overbought: 'Overbought' };

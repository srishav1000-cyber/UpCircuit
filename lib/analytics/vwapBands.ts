// Rolling VWAP with ±1σ and ±2σ fair-value bands.
//   VWAP = Σ(P·V) ÷ ΣV
//   σ    = √( Σ V·(P − VWAP)² ÷ ΣV )      (volume-weighted standard deviation of price around the VWAP)
//   bands = VWAP ± 1σ and VWAP ± 2σ
// A z-score of price vs the VWAP, (LTP − VWAP) ÷ σ, says how many σ the price is from fair value.

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

/** Rolling VWAP = ΣP·V/ΣV with ±k volume-weighted σ bands. */
export function vwapBands(trades: Trade[], k = 2): VwapBands | null {
  let v = 0;
  let pv = 0;
  for (const t of trades) {
    if (!(t.v > 0) || !Number.isFinite(t.p)) continue;
    v += t.v;
    pv += t.p * t.v;
  }
  if (v <= 0) return null;
  const vwap = pv / v;
  let varSum = 0;
  for (const t of trades) if (t.v > 0 && Number.isFinite(t.p)) varSum += t.v * (t.p - vwap) ** 2;
  const sd = Math.sqrt(varSum / v);
  return { vwap, sd, upper: vwap + k * sd, lower: vwap - k * sd, k, n: trades.length };
}

export type BandZone = 'above2' | 'above1' | 'inside' | 'below1' | 'below2';

export interface VwapBandSet {
  vwap: number;
  sd: number;
  upper1: number;
  lower1: number;
  upper2: number;
  lower2: number;
  n: number;
}

export function vwapBandSet(trades: Trade[]): VwapBandSet | null {
  const b = vwapBands(trades, 1);
  if (!b) return null;
  return { vwap: b.vwap, sd: b.sd, upper1: b.vwap + b.sd, lower1: b.vwap - b.sd, upper2: b.vwap + 2 * b.sd, lower2: b.vwap - 2 * b.sd, n: b.n };
}

/** z = (price − VWAP) ÷ σ. σ = 0 (all trades at one price) → 0. */
export const bandZScore = (price: number, b: Pick<VwapBandSet, 'vwap' | 'sd'>): number => (b.sd > 0 ? (price - b.vwap) / b.sd : 0);

export function bandZone(price: number, b: Pick<VwapBandSet, 'vwap' | 'sd'>): BandZone {
  const z = bandZScore(price, b);
  return z > 2 ? 'above2' : z > 1 ? 'above1' : z < -2 ? 'below2' : z < -1 ? 'below1' : 'inside';
}

export const BAND_READ: Record<BandZone, string> = {
  above2: 'Above +2σ — stretched far above fair value',
  above1: 'Between +1σ and +2σ — trading rich vs VWAP',
  inside: 'Inside ±1σ — near fair value',
  below1: 'Between −1σ and −2σ — trading cheap vs VWAP',
  below2: 'Below −2σ — stretched far below fair value',
};

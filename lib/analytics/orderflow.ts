// Order Flow Imbalance from exchange depth: OFI = (ΣBid qty − ΣAsk qty) ÷ (ΣBid qty + ΣAsk qty), range −1 … +1.
// Depth only exists while SmartAPI streams it for the selected symbol; with no depth the result is null (N/A), never estimated.
import type { DepthLevel } from '../types';

export interface Ofi {
  /** −1 (all asks) … +1 (all bids) */
  value: number;
  bidQty: number;
  askQty: number;
  /** per-level imbalance (bidᵢ − askᵢ) ÷ (bidᵢ + askᵢ), best level first */
  levels: number[];
}

const sum = (l: DepthLevel[]) => l.reduce((a, x) => a + (x.qty > 0 ? x.qty : 0), 0);

export function ofi(bids: DepthLevel[], asks: DepthLevel[]): Ofi | null {
  const b = sum(bids);
  const a = sum(asks);
  if (b + a <= 0 || !bids.length || !asks.length) return null;
  const n = Math.min(bids.length, asks.length);
  const levels = Array.from({ length: n }, (_, i) => {
    const bq = Math.max(0, bids[i].qty);
    const aq = Math.max(0, asks[i].qty);
    return bq + aq > 0 ? (bq - aq) / (bq + aq) : 0;
  });
  return { value: (b - a) / (b + a), bidQty: b, askQty: a, levels };
}

export function ofiLabel(v: number): { label: string; tone: 'up' | 'down' | 'muted' } {
  if (v >= 0.6) return { label: 'Extreme buy imbalance', tone: 'up' };
  if (v >= 0.2) return { label: 'Buy pressure', tone: 'up' };
  if (v <= -0.6) return { label: 'Extreme sell imbalance', tone: 'down' };
  if (v <= -0.2) return { label: 'Sell pressure', tone: 'down' };
  return { label: 'Balanced book', tone: 'muted' };
}

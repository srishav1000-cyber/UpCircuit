// Top-5 market-depth imbalance — a HEURISTIC of resting orders, not a forecast: quantity shown in the book can be cancelled before it trades.
//   imbalance = (Σ bid qty − Σ ask qty) ÷ (Σ bid qty + Σ ask qty)   over the best five levels of each side, range −1 (all asks) … +1 (all bids).
import type { DepthLevel } from './types';

export const TOP_N = 5;
/** below this much total quantity across the ten levels the ratio is noise (a lone 100-share order is "+1.00"), so it is reported as N/A */
export const MIN_DEPTH_QTY = 500;

export interface Imbalance {
  value: number;
  bidQty: number;
  askQty: number;
  /** quantity per level, best first (≤ 5 each) */
  bids: number[];
  asks: number[];
  /** per-level (bid − ask) ÷ (bid + ask) for levels present on both sides */
  levels: number[];
}

const clean = (l: DepthLevel[]): DepthLevel[] => l.filter((x) => x && Number.isFinite(x.price) && x.price > 0 && Number.isFinite(x.qty) && x.qty > 0);

/** Best five levels per side (bids by price ↓, asks by price ↑; empty slots dropped). null when the book is too thin or empty (N/A, never 0). */
export function topFiveImbalance(bids: DepthLevel[], asks: DepthLevel[], minTotalQty = MIN_DEPTH_QTY): Imbalance | null {
  const b = clean(bids).sort((x, y) => y.price - x.price).slice(0, TOP_N);
  const a = clean(asks).sort((x, y) => x.price - y.price).slice(0, TOP_N);
  const bidQty = b.reduce((s, x) => s + x.qty, 0);
  const askQty = a.reduce((s, x) => s + x.qty, 0);
  const total = bidQty + askQty;
  if (total <= 0 || total < minTotalQty) return null;
  const n = Math.min(b.length, a.length);
  return {
    value: (bidQty - askQty) / total, bidQty, askQty, bids: b.map((x) => x.qty), asks: a.map((x) => x.qty),
    levels: Array.from({ length: n }, (_, i) => (b[i].qty - a[i].qty) / (b[i].qty + a[i].qty)),
  };
}

export function imbalanceLabel(v: number): { label: string; tone: 'up' | 'down' | 'muted' } {
  if (v >= 0.6) return { label: 'Strongly bid-heavy', tone: 'up' };
  if (v >= 0.2) return { label: 'Bid-heavy', tone: 'up' };
  if (v <= -0.6) return { label: 'Strongly ask-heavy', tone: 'down' };
  if (v <= -0.2) return { label: 'Ask-heavy', tone: 'down' };
  return { label: 'Balanced book', tone: 'muted' };
}

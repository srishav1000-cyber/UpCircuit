// Top-5 market-depth imbalance — a HEURISTIC of resting orders, not a forecast: quantity shown in the book can be cancelled before it trades.
//   imbalance = (Σ bid qty − Σ ask qty) ÷ (Σ bid qty + Σ ask qty)   over the best five levels of each side, range −1 (all asks) … +1 (all bids).
import type { DepthLevel } from './types';

export const TOP_N = 5;
/** below this much total quantity across the ten levels the ratio is noise (a lone 100-share order is "+1.00"), so it is reported as N/A */
export const MIN_DEPTH_QTY = 500;

/** Week 10: distance weights for levels i = 1..5 (best first): w_i = exp(−0.5·(i−1)) → 1, 0.607, 0.368, 0.223, 0.135 */
export const LEVEL_WEIGHTS: readonly number[] = Array.from({ length: TOP_N }, (_, i) => Math.exp(-0.5 * i));
export type ObiMode = 'raw' | 'weighted';

/** (Σ w_i·bid_i − Σ w_i·ask_i) ÷ (Σ w_i·bid_i + Σ w_i·ask_i), level 1 = best price on each side; null when the weighted total is 0 */
export function weightedObi(bids: readonly number[], asks: readonly number[], weights: readonly number[] = LEVEL_WEIGHTS): number | null {
  let b = 0, a = 0;
  for (let i = 0; i < weights.length; i++) { b += weights[i] * (bids[i] ?? 0); a += weights[i] * (asks[i] ?? 0); }
  return b + a > 0 ? (b - a) / (b + a) : null;
}

export interface Imbalance {
  /** equal-weighted ("raw") OBI — what the order_imbalance_* alert rules use */
  value: number;
  /** distance-weighted OBI (LEVEL_WEIGHTS): near-touch quantity counts more than quantity four ticks away */
  weightedValue: number;
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
    value: (bidQty - askQty) / total, weightedValue: weightedObi(b.map((x) => x.qty), a.map((x) => x.qty)) ?? 0, bidQty, askQty, bids: b.map((x) => x.qty), asks: a.map((x) => x.qty),
    levels: Array.from({ length: n }, (_, i) => (b[i].qty - a[i].qty) / (b[i].qty + a[i].qty)),
  };
}

/** the reading for a display mode */
export const obiValue = (i: Imbalance, mode: ObiMode): number => (mode === 'weighted' ? i.weightedValue : i.value);

export function imbalanceLabel(v: number): { label: string; tone: 'up' | 'down' | 'muted' } {
  if (v >= 0.6) return { label: 'Strongly bid-heavy', tone: 'up' };
  if (v >= 0.2) return { label: 'Bid-heavy', tone: 'up' };
  if (v <= -0.6) return { label: 'Strongly ask-heavy', tone: 'down' };
  if (v <= -0.2) return { label: 'Ask-heavy', tone: 'down' };
  return { label: 'Balanced book', tone: 'muted' };
}

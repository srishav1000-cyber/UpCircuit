// Order-book depth slippage estimator.
// Walks the visible depth (top 5 levels from SmartAPI) for a market order of `qty` shares.
//   Average fill  = Σ(priceᵢ × filledᵢ) ÷ Σ filledᵢ
//   Slippage      = |average fill − best price|; shown in ₹ per share, in bps of the best price, and in total ₹
// If `qty` exceeds the visible depth only the visible part is priced (`unfilled` > 0) — the true cost is HIGHER than shown.
// It ignores hidden / iceberg liquidity and book changes while the order executes. Needs live depth; otherwise null (N/A).

export interface BookLevel {
  price: number;
  qty: number;
}

export interface SlippageResult {
  side: 'buy' | 'sell';
  qty: number;
  filled: number;
  unfilled: number;
  avgPrice: number;
  best: number;
  slipPerShare: number;
  slipBps: number;
  slipTotal: number;
  levelsUsed: number;
  /** half-spread relative to mid, bps — the cost of crossing even a 1-share order */
  halfSpreadBps: number | null;
}

/** buy consumes asks (lowest first); sell consumes bids (highest first). */
export function estimateSlippage(bids: BookLevel[], asks: BookLevel[], side: 'buy' | 'sell', qty: number): SlippageResult | null {
  const book = (side === 'buy' ? [...asks].sort((a, b) => a.price - b.price) : [...bids].sort((a, b) => b.price - a.price)).filter((l) => l.qty > 0 && l.price > 0);
  if (book.length === 0 || !(qty > 0)) return null;
  let left = qty;
  let cost = 0;
  let filled = 0;
  let used = 0;
  for (const l of book) {
    if (left <= 0) break;
    const take = Math.min(left, l.qty);
    cost += take * l.price;
    filled += take;
    left -= take;
    used++;
  }
  const avg = cost / filled;
  const best = book[0].price;
  const slip = Math.abs(avg - best);
  const bb = bids.length ? Math.max(...bids.map((b) => b.price)) : NaN;
  const ba = asks.length ? Math.min(...asks.map((a) => a.price)) : NaN;
  const mid = (bb + ba) / 2;
  return { side, qty, filled, unfilled: Math.max(0, qty - filled), avgPrice: avg, best, slipPerShare: slip, slipBps: (slip / best) * 1e4, slipTotal: slip * filled, levelsUsed: used, halfSpreadBps: Number.isFinite(mid) && mid > 0 ? (((ba - bb) / 2) / mid) * 1e4 : null };
}

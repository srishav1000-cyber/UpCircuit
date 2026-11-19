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
  /** total quantity visible on the side being consumed (≤ 5 levels) and the share of it this order takes, % */
  visibleQty: number;
  depthConsumedPct: number;
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
  return { side, qty, filled, unfilled: Math.max(0, qty - filled), avgPrice: avg, best, slipPerShare: slip, slipBps: (slip / best) * 1e4, slipTotal: slip * filled, levelsUsed: used, visibleQty: book.reduce((a, l) => a + l.qty, 0), depthConsumedPct: (filled / book.reduce((a, l) => a + l.qty, 0)) * 100, halfSpreadBps: Number.isFinite(mid) && mid > 0 ? (((ba - bb) / 2) / mid) * 1e4 : null };
}

/* ───────────── Week 11: live slippage + circuit-lock exit-risk report ─────────────
 * VWAP fill over the visible 5 levels, slippage in ₹ and bps, % of visible depth consumed — and a warning when an exit order might not fill:
 *   • LTP within NEAR_CIRCUIT_PCT (1.5 %) of the upper or lower circuit price (a locked stock has one-sided queues), or
 *   • the depth the order would consume (bids for a sell, asks for a buy) is below THIN_DEPTH_RATIO (25 %) of its own session median.
 * The session median is built from this browser session's observations (SessionDepthMedian) and is N/A until it has MIN_MEDIAN_SAMPLES.
 * Everything is N/A (never zero) when the market is closed or no live 5-level depth is present. A warning is a screening aid, not a prediction. */
export const NEAR_CIRCUIT_PCT = 1.5;
export const THIN_DEPTH_RATIO = 0.25;
export const MIN_MEDIAN_SAMPLES = 20;
export const DEFAULT_CAPITAL = 100_000;

/** a sensible default order size: ₹1 lakh of notional (the classic impact-cost benchmark), at least 1 share */
export const defaultQty = (ltp: number | null | undefined, capital = DEFAULT_CAPITAL): number => (ltp && ltp > 0 ? Math.max(1, Math.floor(capital / ltp)) : 100);

export class SessionDepthMedian {
  private readonly s = new Map<string, { t: number; q: number }[]>();
  constructor(private readonly everyMs = 5_000, private readonly cap = 720) {}
  push(symbol: string, side: 'bid' | 'ask', totalQty: number, now = Date.now()): void {
    if (!(totalQty > 0) || !Number.isFinite(totalQty)) return;
    const k = `${symbol.toUpperCase()}|${side}`, a = this.s.get(k) ?? [];
    if (a.length && now - a[a.length - 1].t < this.everyMs) return;
    a.push({ t: now, q: totalQty }); if (a.length > this.cap) a.shift();
    this.s.set(k, a);
  }
  /** null until MIN_MEDIAN_SAMPLES observations */
  median(symbol: string, side: 'bid' | 'ask'): { value: number; samples: number } | null {
    const a = this.s.get(`${symbol.toUpperCase()}|${side}`);
    if (!a || a.length < MIN_MEDIAN_SAMPLES) return null;
    const v = a.map((x) => x.q).sort((x, y) => x - y), m = v.length >> 1;
    return { value: v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2, samples: v.length };
  }
  samples(symbol: string, side: 'bid' | 'ask'): number { return this.s.get(`${symbol.toUpperCase()}|${side}`)?.length ?? 0; }
  clear(): void { this.s.clear(); }
}

export type ExitRiskReason = 'near_upper_circuit' | 'near_lower_circuit' | 'thin_depth';
export interface ExitRisk {
  warn: boolean;
  reasons: ExitRiskReason[];
  /** distance from LTP to each circuit price, % of LTP (null when the band is unknown) */
  toUpperPct: number | null; toLowerPct: number | null;
  bandKnown: boolean;
  /** quantity on the side the order would consume, its session median and the ratio (null = median not yet available) */
  consumedSideQty: number; sessionMedianQty: number | null; depthRatio: number | null; medianSamples: number;
  message: string | null;
}
export interface ExitRiskInput { side: 'buy' | 'sell'; ltp: number; upperCircuit?: number | null; lowerCircuit?: number | null; bandKnown?: boolean; consumedSideQty: number; sessionMedianQty: number | null; medianSamples?: number }
export function circuitLockExitRisk(i: ExitRiskInput): ExitRisk {
  const up = i.upperCircuit && i.upperCircuit > 0 ? i.upperCircuit : null, lo = i.lowerCircuit && i.lowerCircuit > 0 ? i.lowerCircuit : null;
  const toUp = up && i.ltp > 0 ? ((up - i.ltp) / i.ltp) * 100 : null, toLo = lo && i.ltp > 0 ? ((i.ltp - lo) / i.ltp) * 100 : null;
  const reasons: ExitRiskReason[] = [];
  if (toUp !== null && toUp <= NEAR_CIRCUIT_PCT) reasons.push('near_upper_circuit');
  if (toLo !== null && toLo <= NEAR_CIRCUIT_PCT) reasons.push('near_lower_circuit');
  const ratio = i.sessionMedianQty && i.sessionMedianQty > 0 ? i.consumedSideQty / i.sessionMedianQty : null;
  if (ratio !== null && ratio < THIN_DEPTH_RATIO) reasons.push('thin_depth');
  const parts: string[] = [];
  if (reasons.includes('near_lower_circuit')) parts.push(`LTP is ${toLo!.toFixed(2)}% above the lower circuit — if it locks, sell queues dominate and a sell exit may not fill`);
  if (reasons.includes('near_upper_circuit')) parts.push(`LTP is ${toUp!.toFixed(2)}% below the upper circuit — if it locks, buy queues dominate and a buy / short-cover exit may not fill`);
  if (reasons.includes('thin_depth')) parts.push(`the ${i.side === 'buy' ? 'ask' : 'bid'} side shows ${Math.round(ratio! * 100)}% of its session median depth`);
  return {
    warn: reasons.length > 0, reasons, toUpperPct: toUp, toLowerPct: toLo, bandKnown: !!i.bandKnown, consumedSideQty: i.consumedSideQty, sessionMedianQty: i.sessionMedianQty, depthRatio: ratio, medianSamples: i.medianSamples ?? 0,
    message: parts.length ? `Circuit-lock exit risk: ${parts.join('; ')}. Exit orders may not fill.` : null,
  };
}

export type SlippageReport =
  | { status: 'na'; reason: 'market_closed' | 'no_depth' | 'bad_quantity'; message: string }
  | { status: 'ok'; fill: SlippageResult; exit: ExitRisk; bandInferred: boolean };
export interface SlippageReportInput {
  bids: BookLevel[] | null | undefined; asks: BookLevel[] | null | undefined; side: 'buy' | 'sell'; qty: number;
  ltp: number; upperCircuit?: number | null; lowerCircuit?: number | null; bandKnown?: boolean;
  marketOpen: boolean; sessionMedian?: { value: number; samples: number } | null; medianSamples?: number;
}
export function slippageReport(i: SlippageReportInput): SlippageReport {
  if (!i.marketOpen) return { status: 'na', reason: 'market_closed', message: 'N/A — the market is closed (09:15–15:30 IST, Mon–Fri); live 5-level depth is only streamed during the session.' };
  const bids = (i.bids ?? []).filter((l) => l.qty > 0 && l.price > 0), asks = (i.asks ?? []).filter((l) => l.qty > 0 && l.price > 0);
  if (!bids.length || !asks.length) return { status: 'na', reason: 'no_depth', message: 'N/A — live 5-level order-book depth is not available for this symbol right now.' };
  const fill = estimateSlippage(bids, asks, i.side, i.qty);
  if (!fill) return { status: 'na', reason: 'bad_quantity', message: 'Enter a positive quantity.' };
  const exit = circuitLockExitRisk({ side: i.side, ltp: i.ltp, upperCircuit: i.upperCircuit, lowerCircuit: i.lowerCircuit, bandKnown: i.bandKnown, consumedSideQty: fill.visibleQty, sessionMedianQty: i.sessionMedian?.value ?? null, medianSamples: i.sessionMedian?.samples ?? i.medianSamples ?? 0 });
  return { status: 'ok', fill, exit, bandInferred: !i.bandKnown };
}

// Portfolio concentration & market-risk diagnostics.
//   HHI = Σ sᵢ²                     sᵢ = weight of asset (or sector) i in PERCENT → 0…10 000   (computed for STOCKS and for SECTORS)
//   β   = Cov(Rp, Rm) ÷ Var(Rm)      Rp = daily returns of the holdings' combined value, Rm = NIFTY 50 daily returns (right-aligned, ≥ 30 pairs)
//   Sharpe = (Rp − Rf) ÷ σp          annualised on the same portfolio series (Rf = 6.5 %, see correlation.ts)
// Everything is computed from real 1Y daily closes; nothing is estimated when history is missing (→ null / "N/A").
import { hhiPct, sectorWeights, HHI_HIGH, HHI_MODERATE, type Position } from './hhi';
import { sharpeParts, simpleReturns, type SharpeParts } from './correlation';

export interface StockWeight { symbol: string; value: number; weightPct: number }
export function stockWeights(positions: Position[]): StockWeight[] {
  const live = positions.filter((p) => p.value > 0 && Number.isFinite(p.value));
  const total = live.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return [];
  const by = new Map<string, number>();
  for (const p of live) by.set(p.symbol, (by.get(p.symbol) ?? 0) + p.value);
  return [...by.entries()].map(([symbol, value]) => ({ symbol, value, weightPct: (value / total) * 100 })).sort((a, b) => b.value - a.value);
}

export type RiskBadge = 'LOW CONCENTRATION' | 'MODERATE RISK' | 'HIGH CONCENTRATION RISK';
export type RiskZone = 'green' | 'yellow' | 'red';
/** judged on the WORSE of the stock and sector HHI: > 2 500 high · 1 500–2 500 moderate · < 1 500 low */
export function riskBadge(stockHhi: number, sectorHhi: number): { label: RiskBadge; zone: RiskZone } {
  const h = Math.max(stockHhi, sectorHhi);
  if (h > HHI_HIGH) return { label: 'HIGH CONCENTRATION RISK', zone: 'red' };
  if (h >= HHI_MODERATE) return { label: 'MODERATE RISK', zone: 'yellow' };
  return { label: 'LOW CONCENTRATION', zone: 'green' };
}

/** OLS slope of portfolio returns on benchmark returns; null with < 30 paired observations or a flat benchmark */
export function betaOf(portfolio: number[], benchmark: number[]): number | null {
  const n = Math.min(portfolio.length, benchmark.length);
  if (n < 30) return null;
  const p = portfolio.slice(-n);
  const m = benchmark.slice(-n);
  const mp = p.reduce((a, b) => a + b, 0) / n;
  const mm = m.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < n; i++) { cov += (p[i] - mp) * (m[i] - mm); varM += (m[i] - mm) ** 2; }
  return varM > 1e-14 ? cov / varM : null;
}

export interface PortfolioRisk {
  total: number;
  stocks: StockWeight[];
  sectors: { sector: string; weightPct: number }[];
  stockHhi: number;
  sectorHhi: number;
  badge: { label: RiskBadge; zone: RiskZone };
  beta: number | null;
  sharpe: SharpeParts | null;
  /** paired return observations behind beta / Sharpe */
  obs: number;
}

/** `closes[i]` are the daily closes of positions[i] (any length); `nifty` the NIFTY 50 daily closes */
export function portfolioRisk(positions: Position[], qtys: number[], closes: number[][], nifty: number[]): PortfolioRisk {
  const stocks = stockWeights(positions);
  const sectors = sectorWeights(positions);
  const stockHhi = hhiPct(stocks.map((s) => s.weightPct));
  const sectorHhi = hhiPct(sectors.map((s) => s.weightPct));
  // combined value over the shortest common history (right-aligned), same convention as portfolioValueSeries
  const usable = closes.map((c, i) => ({ c, q: qtys[i] ?? 0 })).filter((x) => x.c.length >= 2 && x.q > 0);
  let values: number[] = [];
  if (usable.length) {
    const n = Math.min(...usable.map((x) => x.c.length));
    values = Array.from({ length: n }, (_, t) => usable.reduce((a, x) => a + x.q * x.c[x.c.length - n + t], 0));
  }
  const rp = simpleReturns(values);
  const rm = simpleReturns(nifty);
  return {
    total: stocks.reduce((a, s) => a + s.value, 0),
    stocks,
    sectors: sectors.map((s) => ({ sector: s.sector, weightPct: s.weightPct })),
    stockHhi,
    sectorHhi,
    badge: riskBadge(stockHhi, sectorHhi),
    beta: betaOf(rp, rm),
    sharpe: values.length >= 30 ? sharpeParts(values) : null,
    obs: Math.min(rp.length, rm.length),
  };
}

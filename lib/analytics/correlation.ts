// Return statistics: simple returns, Pearson correlation matrix, Sharpe ratio.
//   r      = cov(x, y) ÷ (σx σy)                    on daily simple returns
//   Sharpe = (Rp − Rf) ÷ σ, annualised               Rp = mean daily return × 252, σ = daily sd × √252, Rf = 6.5 % (India 10Y G-Sec proxy)

export const TRADING_DAYS = 252;
export const RISK_FREE = 0.065;

export const simpleReturns = (closes: number[]): number[] => {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i - 1] - 1);
  return r;
};

/** Pearson correlation r = cov(x, y) / (σx σy). Series are right-aligned to the shorter length. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(a.length - n);
  const y = b.slice(b.length - n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

export interface CorrMatrix {
  symbols: string[];
  matrix: number[][];
}

/** Correlation matrix of daily simple returns for the given close series. */
export function correlationMatrix(series: Record<string, number[]>): CorrMatrix {
  const symbols = Object.keys(series);
  const rets = symbols.map((s) => simpleReturns(series[s]));
  const matrix = symbols.map((_, i) => symbols.map((__, j) => (i === j ? 1 : pearson(rets[i], rets[j]))));
  return { symbols, matrix };
}

/** Mean of the off-diagonal entries — the basket's average pairwise correlation (null with < 2 names). */
export function avgPairwise(m: CorrMatrix): number | null {
  const n = m.symbols.length;
  if (n < 2) return null;
  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { s += m.matrix[i][j]; c++; }
  return s / c;
}

/** Most and least correlated distinct pairs. */
export function extremePairs(m: CorrMatrix): { high: { a: string; b: string; r: number }; low: { a: string; b: string; r: number } } | null {
  const n = m.symbols.length;
  if (n < 2) return null;
  let high = { a: m.symbols[0], b: m.symbols[1], r: m.matrix[0][1] };
  let low = high;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const r = m.matrix[i][j];
      if (r > high.r) high = { a: m.symbols[i], b: m.symbols[j], r };
      if (r < low.r) low = { a: m.symbols[i], b: m.symbols[j], r };
    }
  return { high, low };
}

export const corrWord = (r: number): string => {
  const a = Math.abs(r);
  const s = a >= 0.7 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'negligible';
  return a < 0.2 ? s : `${s} ${r > 0 ? 'positive' : 'negative'}`;
};

export interface SharpeParts {
  sharpe: number;
  annReturnPct: number;
  annVolPct: number;
}

/** Sharpe = (Rp − Rf) / σ on a daily value series (needs ≥ 30 points; flat series → null). */
export function sharpeParts(values: number[], rf = RISK_FREE): SharpeParts | null {
  if (values.length < 30) return null;
  const r = simpleReturns(values);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
  if (!Number.isFinite(sd) || sd < 1e-9) return null;
  const rp = mean * TRADING_DAYS;
  const vol = sd * Math.sqrt(TRADING_DAYS);
  return { sharpe: (rp - rf) / vol, annReturnPct: rp * 100, annVolPct: vol * 100 };
}

/** Annualised Sharpe from simple daily returns, daily-compounded risk-free (rf annual). Kept for the per-stock tile. */
export function sharpe(closes: number[], rf = RISK_FREE): number | null {
  if (closes.length < 30) return null;
  const rfd = rf / TRADING_DAYS;
  const ex = simpleReturns(closes).map((r) => r - rfd);
  const mean = ex.reduce((a, b) => a + b, 0) / ex.length;
  const sd = Math.sqrt(ex.reduce((a, b) => a + (b - mean) ** 2, 0) / (ex.length - 1));
  return !Number.isFinite(sd) || sd < 1e-9 ? null : (mean / sd) * Math.sqrt(TRADING_DAYS);
}

// Relative strength vs a benchmark (NIFTY 50) over 1D / 1W / 1M.
//   Return(n) = last close ÷ close n trading days earlier − 1       1D = 1 day, 1W = 5 trading days, 1M = 21 trading days
//   Relative strength (pp) = stock return − benchmark return, in percentage points. > 0 = outperforming.
// 1D uses the live day change (LTP vs previous close) for both; 1W / 1M use daily closes (null when the history is too short).

export const PERIODS = [{ id: '1D', days: 1 }, { id: '1W', days: 5 }, { id: '1M', days: 21 }] as const;
export type PeriodId = (typeof PERIODS)[number]['id'];

export function periodReturnPct(closes: number[], days: number): number | null {
  if (closes.length <= days) return null;
  const a = closes[closes.length - 1 - days];
  const b = closes[closes.length - 1];
  return a > 0 && Number.isFinite(a) && Number.isFinite(b) ? (b / a - 1) * 100 : null;
}

export interface RelRow {
  id: PeriodId;
  stock: number | null;
  bench: number | null;
  /** percentage points, stock − benchmark */
  rs: number | null;
}

export function relativeStrength(stockCloses: number[], benchCloses: number[], stockDayPct: number | null, benchDayPct: number | null): RelRow[] {
  return PERIODS.map((p) => {
    const stock = p.id === '1D' ? stockDayPct : periodReturnPct(stockCloses, p.days);
    const bench = p.id === '1D' ? benchDayPct : periodReturnPct(benchCloses, p.days);
    return { id: p.id, stock, bench, rs: stock !== null && bench !== null ? stock - bench : null };
  });
}

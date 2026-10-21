// Financial-health traffic lights: Solvency, Profitability, Valuation, Momentum — each green / yellow / red / n/a with a one-line reason.
// Thresholds are fixed, stated rules of thumb (no sector adjustment, no forecasts). Missing inputs give "na", never a guess.
//
//   Solvency       debt-to-equity   ≤ 0.5 green · ≤ 1.5 yellow · > 1.5 red      (banks/lenders: not meaningful → na)
//   Profitability  ROE %            ≥ 15 green · ≥ 8 yellow · < 8 red           (falls back to ROCE when ROE is missing)
//   Valuation      P/E              ≤ 0 (loss-making) red · ≤ 25 green · ≤ 45 yellow · > 45 red
//   Momentum       score = (RSI14 ≥ 50) + (1M return > 0) + (price ≥ VWAP when known);  all true green · RSI ≥ 75 caps at yellow (stretched) ·
//                  mixed yellow · none red

export type Light = 'green' | 'yellow' | 'red' | 'na';
export interface HealthLight {
  id: 'solvency' | 'profitability' | 'valuation' | 'momentum';
  label: string;
  light: Light;
  summary: string;
}

export interface HealthInput {
  debtToEquity: number | null;
  roe: number | null;
  roce: number | null;
  pe: number | null;
  rsi: number | null;
  ret1mPct: number | null;
  aboveVwap: boolean | null;
}

const f = (v: number, dp = 1) => v.toFixed(dp);

export function healthLights(i: HealthInput): HealthLight[] {
  let sol: HealthLight;
  if (i.debtToEquity === null) sol = { id: 'solvency', label: 'Solvency', light: 'na', summary: 'Debt-to-equity is not available (or not meaningful for lenders).' };
  else if (i.debtToEquity <= 0.5) sol = { id: 'solvency', label: 'Solvency', light: 'green', summary: `Low borrowing: debt is ${f(i.debtToEquity, 2)}× equity.` };
  else if (i.debtToEquity <= 1.5) sol = { id: 'solvency', label: 'Solvency', light: 'yellow', summary: `Moderate borrowing: debt is ${f(i.debtToEquity, 2)}× equity.` };
  else sol = { id: 'solvency', label: 'Solvency', light: 'red', summary: `Heavy borrowing: debt is ${f(i.debtToEquity, 2)}× equity.` };

  const r = i.roe ?? i.roce;
  const rn = i.roe !== null ? 'ROE' : 'ROCE';
  let prof: HealthLight;
  if (r === null) prof = { id: 'profitability', label: 'Profitability', light: 'na', summary: 'Return on equity / capital is not available.' };
  else if (r >= 15) prof = { id: 'profitability', label: 'Profitability', light: 'green', summary: `Earns ${f(r)}% ${rn} — strong returns on shareholder money.` };
  else if (r >= 8) prof = { id: 'profitability', label: 'Profitability', light: 'yellow', summary: `Earns ${f(r)}% ${rn} — adequate but unspectacular.` };
  else prof = { id: 'profitability', label: 'Profitability', light: 'red', summary: `Earns only ${f(r)}% ${rn} — weak returns.` };

  let val: HealthLight;
  if (i.pe === null) val = { id: 'valuation', label: 'Valuation', light: 'na', summary: 'P/E is not available.' };
  else if (i.pe <= 0) val = { id: 'valuation', label: 'Valuation', light: 'red', summary: 'Loss-making: earnings are negative, so P/E is not meaningful.' };
  else if (i.pe <= 25) val = { id: 'valuation', label: 'Valuation', light: 'green', summary: `P/E ${f(i.pe)} — not expensive on earnings.` };
  else if (i.pe <= 45) val = { id: 'valuation', label: 'Valuation', light: 'yellow', summary: `P/E ${f(i.pe)} — priced for growth.` };
  else val = { id: 'valuation', label: 'Valuation', light: 'red', summary: `P/E ${f(i.pe)} — expensive on current earnings.` };

  let mom: HealthLight;
  if (i.rsi === null && i.ret1mPct === null) mom = { id: 'momentum', label: 'Momentum', light: 'na', summary: 'Not enough price history for momentum.' };
  else {
    const checks = [i.rsi !== null ? i.rsi >= 50 : null, i.ret1mPct !== null ? i.ret1mPct > 0 : null, i.aboveVwap];
    const known = checks.filter((c): c is boolean => c !== null);
    const good = known.filter(Boolean).length;
    let light: Light = good === known.length ? 'green' : good === 0 ? 'red' : 'yellow';
    const stretched = i.rsi !== null && i.rsi >= 75;
    if (stretched && light === 'green') light = 'yellow';
    const bits = [i.rsi !== null ? `RSI ${f(i.rsi, 0)}` : null, i.ret1mPct !== null ? `1M ${i.ret1mPct >= 0 ? '+' : ''}${f(i.ret1mPct)}%` : null, i.aboveVwap === null ? null : i.aboveVwap ? 'above VWAP' : 'below VWAP'].filter(Boolean).join(' · ');
    mom = { id: 'momentum', label: 'Momentum', light, summary: `${light === 'green' ? 'Trend is positive' : light === 'red' ? 'Trend is weak' : stretched ? 'Strong but stretched (overbought)' : 'Mixed signals'} (${bits}).` };
  }
  return [sol, prof, val, mom];
}

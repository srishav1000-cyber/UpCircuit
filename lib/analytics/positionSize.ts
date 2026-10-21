// Position size and stop-loss calculator (analysis only — UpCircuit places no orders).
//   Risk ₹      = capital × risk %
//   Per-share R = |entry − stop|
//   Quantity    = ⌊ Risk ₹ ÷ R ⌋, capped at ⌊ capital ÷ entry ⌋ (cash only, no leverage)
//   Targets     = entry ± k·R for 1R, 2R, 3R (long: +, short: −)
// Warnings: stop outside the day's circuit band (the order could never trigger inside the allowed range), stop on the wrong side
// of entry, zero distance, and a stop tighter than 0.1 % (noise will hit it).

export interface PositionInput {
  capital: number;
  riskPct: number;
  entry: number;
  stop: number;
  /** today's lower / upper circuit prices when known */
  lowerCircuit?: number;
  upperCircuit?: number;
}

export interface PositionPlan {
  side: 'long' | 'short';
  riskRupees: number;
  perShareRisk: number;
  qty: number;
  cappedByCash: boolean;
  positionValue: number;
  positionPct: number;
  /** actual ₹ loss if the stop is hit with `qty` shares */
  lossAtStop: number;
  targets: { r: number; price: number; gain: number }[];
  warnings: string[];
}

export function planPosition(i: PositionInput): PositionPlan | { error: string } {
  if (![i.capital, i.riskPct, i.entry, i.stop].every(Number.isFinite) || i.capital <= 0 || i.entry <= 0 || i.stop <= 0) return { error: 'Enter positive capital, entry and stop.' };
  if (i.riskPct <= 0 || i.riskPct > 100) return { error: 'Risk per trade must be between 0 and 100 %.' };
  const per = Math.abs(i.entry - i.stop);
  if (per === 0) return { error: 'Stop must differ from entry.' };
  const side = i.stop < i.entry ? 'long' : 'short';
  const riskRupees = (i.capital * i.riskPct) / 100;
  const byRisk = Math.floor(riskRupees / per);
  const byCash = Math.floor(i.capital / i.entry);
  const qty = Math.max(0, Math.min(byRisk, byCash));
  const warnings: string[] = [];
  if (byRisk > byCash) warnings.push('Cash-limited: the risk budget allows more shares than your capital can buy (no leverage assumed).');
  if (qty === 0) warnings.push('Quantity is 0 — the stop is too wide for this risk budget or the price exceeds capital.');
  if (i.lowerCircuit && i.stop < i.lowerCircuit) warnings.push(`Stop ₹${i.stop.toFixed(2)} is below today's lower circuit ₹${i.lowerCircuit.toFixed(2)} — it can never trigger inside the allowed range.`);
  if (i.upperCircuit && i.stop > i.upperCircuit) warnings.push(`Stop ₹${i.stop.toFixed(2)} is above today's upper circuit ₹${i.upperCircuit.toFixed(2)} — it can never trigger inside the allowed range.`);
  if (per / i.entry < 0.001) warnings.push('Stop is within 0.1 % of entry — normal noise is likely to hit it.');
  const dir = side === 'long' ? 1 : -1;
  return {
    side,
    riskRupees,
    perShareRisk: per,
    qty,
    cappedByCash: byRisk > byCash,
    positionValue: qty * i.entry,
    positionPct: ((qty * i.entry) / i.capital) * 100,
    lossAtStop: qty * per,
    targets: [1, 2, 3].map((r) => ({ r, price: i.entry + dir * r * per, gain: qty * r * per })),
    warnings,
  };
}

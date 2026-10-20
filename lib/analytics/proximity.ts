// Circuit Proximity Predictor.
//   Proximity_upper = (UpperLimit − LTP) ÷ UpperLimit × 100      Proximity_lower = (LTP − LowerLimit) ÷ LowerLimit × 100
// Uses the exchange limits when SmartAPI supplied them (bandKnown); otherwise the next un-reached 5 / 10 / 20 % band on the side the stock is
// moving, flagged `inferred` — a stock may in reality have a wider band, so an inferred row is a heads-up, not a halt forecast.
import { CIRCUIT_BANDS, limitPrice, type CircuitDir, type CircuitQuote } from '../circuit';

export const NEAR_PCT = 1.5;

export interface Proximity {
  symbol: string;
  dir: CircuitDir;
  band: number;
  limit: number;
  ltp: number;
  /** % of the limit price still to travel; ≤ 0 means already at the limit */
  proximityPct: number;
  inferred: boolean;
}

export const proximityUpper = (upper: number, ltp: number) => ((upper - ltp) / upper) * 100;
export const proximityLower = (lower: number, ltp: number) => ((ltp - lower) / lower) * 100;

export function proximityOf(q: CircuitQuote): Proximity | null {
  if (!(q.ltp > 0) || !(q.prevClose > 0)) return null;
  if (q.bandKnown && q.upperCircuit && q.lowerCircuit) {
    const pu = proximityUpper(q.upperCircuit, q.ltp);
    const pl = proximityLower(q.lowerCircuit, q.ltp);
    const upper = pu <= pl;
    return { symbol: q.symbol, dir: upper ? 'upper' : 'lower', band: q.circuitBand ?? Math.round(Math.abs(q.upperCircuit / q.prevClose - 1) * 100), limit: upper ? q.upperCircuit : q.lowerCircuit, ltp: q.ltp, proximityPct: upper ? pu : pl, inferred: false };
  }
  const pct = (q.ltp / q.prevClose - 1) * 100;
  const dir: CircuitDir = pct >= 0 ? 'upper' : 'lower';
  const band = CIRCUIT_BANDS.find((b) => b >= Math.abs(pct) - 1e-9) ?? CIRCUIT_BANDS[CIRCUIT_BANDS.length - 1];
  const limit = limitPrice(q.prevClose, band, dir);
  return { symbol: q.symbol, dir, band, limit, ltp: q.ltp, proximityPct: dir === 'upper' ? proximityUpper(limit, q.ltp) : proximityLower(limit, q.ltp), inferred: true };
}

/** Stocks within `within` % of a limit and not yet at it, closest first. */
export function circuitWatchlist(quotes: Iterable<CircuitQuote>, within = NEAR_PCT, max = 12): Proximity[] {
  const out: Proximity[] = [];
  for (const q of quotes) {
    const p = proximityOf(q);
    if (p && p.proximityPct > 0.005 && p.proximityPct <= within) out.push(p);
  }
  return out.sort((a, b) => a.proximityPct - b.proximityPct).slice(0, max);
}

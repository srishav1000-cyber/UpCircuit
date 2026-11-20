// Holdings Surveillance & Liquidity Risk: cross-references the user's holdings / MY FOCUS names with recent heuristic flags, circuit-band proximity (≤ 2 %)
// and the visible 5-level exit depth. Pure; every input that is unavailable yields "na" for that check, never a guess. A screening aid, not advice.
import type { DepthLevel } from '../types';

export const PORTFOLIO_NEAR_PCT = 2;
export const FLAG_LOOKBACK_MS = 30 * 60_000;
export type SurvLevel = 'high' | 'watch' | 'clear' | 'na';
export type SurvReason = 'multi_signal_flag' | 'baseline_flag' | 'near_upper_circuit' | 'near_lower_circuit' | 'thin_exit_depth_near_circuit' | 'thin_exit_depth';

export interface SurvQuote { ltp: number; upperCircuit?: number | null; lowerCircuit?: number | null }
export interface SurvFlag { symbol: string; ts: number; confirmed: boolean }
export interface SurvHolding { symbol: string; qty: number; focus?: boolean }
export interface SurvInput {
  holdings: SurvHolding[];
  quotes: (symbol: string) => SurvQuote | undefined;
  flags: SurvFlag[];
  /** live 5-level book per symbol — only symbols whose depth is streaming; missing = N/A */
  depth?: (symbol: string) => { bids: readonly DepthLevel[]; asks: readonly DepthLevel[] } | null | undefined;
  now: number;
  nearPct?: number;
}
export interface SurvRow {
  symbol: string; focus: boolean; level: SurvLevel; reasons: SurvReason[];
  toUpperPct: number | null; toLowerPct: number | null;
  /** visible bid qty ÷ holding qty (null = depth N/A); < 1 means the holding is larger than everything visible on the exit side */
  exitCoverage: number | null; depthAvailable: boolean;
  confirmedFlags: number; baselineFlags: number;
}
export interface SurvSummary {
  level: SurvLevel; label: string; rows: SurvRow[];
  high: number; watch: number; clear: number; na: number;
  /** how many holdings had a live book to check exit depth against */
  depthChecked: number;
}

export function holdingsSurveillance(i: SurvInput): SurvSummary {
  const near = i.nearPct ?? PORTFOLIO_NEAR_PCT;
  const rows: SurvRow[] = i.holdings.map((h) => {
    const sym = h.symbol.toUpperCase(), q = i.quotes(sym);
    const mine = i.flags.filter((f) => f.symbol.toUpperCase() === sym && i.now - f.ts <= FLAG_LOOKBACK_MS && i.now >= f.ts);
    const confirmedFlags = mine.filter((f) => f.confirmed).length, baselineFlags = mine.length - confirmedFlags;
    const up = q?.upperCircuit && q.upperCircuit > 0 && q.ltp > 0 ? ((q.upperCircuit - q.ltp) / q.upperCircuit) * 100 : null;
    const lo = q?.lowerCircuit && q.lowerCircuit > 0 && q.ltp > 0 ? ((q.ltp - q.lowerCircuit) / q.lowerCircuit) * 100 : null;
    const d = i.depth?.(sym);
    const bids = (d?.bids ?? []).filter((l) => l.qty > 0 && l.price > 0);
    const depthAvailable = bids.length > 0;
    const exitCoverage = depthAvailable && h.qty > 0 ? bids.reduce((a, l) => a + l.qty, 0) / h.qty : null;
    const nearUp = up !== null && up <= near, nearLo = lo !== null && lo <= near, thin = exitCoverage !== null && exitCoverage < 1;
    const reasons: SurvReason[] = [];
    if (confirmedFlags) reasons.push('multi_signal_flag'); else if (baselineFlags) reasons.push('baseline_flag');
    if (nearUp) reasons.push('near_upper_circuit');
    if (nearLo) reasons.push('near_lower_circuit');
    if (thin && (nearUp || nearLo)) reasons.push('thin_exit_depth_near_circuit'); else if (thin) reasons.push('thin_exit_depth');
    const high = reasons.includes('multi_signal_flag') || reasons.includes('thin_exit_depth_near_circuit');
    const watch = !high && (reasons.length > 0);
    const known = !!q && (q.ltp > 0);
    const level: SurvLevel = high ? 'high' : watch ? 'watch' : known ? 'clear' : 'na';
    return { symbol: sym, focus: !!h.focus, level, reasons, toUpperPct: up, toLowerPct: lo, exitCoverage, depthAvailable, confirmedFlags, baselineFlags };
  });
  const c = (l: SurvLevel) => rows.filter((r) => r.level === l).length;
  const high = c('high'), watch = c('watch'), clear = c('clear'), na = c('na');
  const level: SurvLevel = !rows.length ? 'na' : high ? 'high' : watch ? 'watch' : clear ? 'clear' : 'na';
  const label = !rows.length ? 'No holdings to check' : high ? `${high} holding${high > 1 ? 's' : ''} at elevated surveillance / liquidity risk` : watch ? `${watch} holding${watch > 1 ? 's' : ''} on watch` : clear ? 'No surveillance or liquidity flags on your holdings' : 'Surveillance data N/A';
  return { level, label, rows: rows.sort((a, b) => ['high', 'watch', 'clear', 'na'].indexOf(a.level) - ['high', 'watch', 'clear', 'na'].indexOf(b.level)), high, watch, clear, na, depthChecked: rows.filter((r) => r.depthAvailable).length };
}

export const REASON_TEXT: Record<SurvReason, string> = {
  multi_signal_flag: 'Multi-Signal Confirmed pattern in the last 30 min',
  baseline_flag: 'Baseline (single-rule) flag in the last 30 min',
  near_upper_circuit: 'within 2% of the upper circuit',
  near_lower_circuit: 'within 2% of the lower circuit',
  thin_exit_depth_near_circuit: 'your quantity exceeds the visible 5-level exit depth, near a circuit limit',
  thin_exit_depth: 'your quantity exceeds the visible 5-level exit depth',
};

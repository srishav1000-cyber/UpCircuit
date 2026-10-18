import type { Quote } from './types';

/** "Near" a circuit = the move has used ≥ 90 % of the stock's price band; "locked" = at / beyond the band price (within half a tick). */
export const NEAR_BAND = 0.9;
export const SURGE_MULTIPLE = 3;
export const BANDS = [5, 10, 20] as const;

export interface AnomalyRow {
  symbol: string;
  name: string;
  ltp: number;
  pct: number;
  band: number;
  /** share of the band used, 0–1+ */
  usedPct: number;
  locked: boolean;
  /** current volume ÷ average (typical full-day) volume */
  volMultiple: number;
  /** flagged by the engine's live volume-burst detector (last-second volume ≥ 3× its running baseline) rather than by the day's total */
  burst?: boolean;
}

type Q = Pick<Quote, 'symbol' | 'name' | 'ltp' | 'prevClose' | 'circuitBand' | 'upperCircuit' | 'lowerCircuit' | 'volume' | 'avgVolume'>;

export function toRow(q: Q): AnomalyRow | null {
  if (!(q.prevClose > 0) || !Number.isFinite(q.ltp) || !(q.circuitBand > 0)) return null;
  const pct = ((q.ltp - q.prevClose) / q.prevClose) * 100;
  const used = Math.abs(pct) / q.circuitBand;
  const edge = pct >= 0 ? q.upperCircuit : q.lowerCircuit;
  const locked = Number.isFinite(edge) && edge > 0 && (pct >= 0 ? q.ltp >= edge - 0.005 : q.ltp <= edge + 0.005);
  return { symbol: q.symbol, name: q.name, ltp: q.ltp, pct, band: q.circuitBand, usedPct: used, locked, volMultiple: q.avgVolume > 0 ? q.volume / q.avgVolume : 0 };
}

/** Splits the active universe into the three desk tabs. Upper / lower sorted by band utilisation, surges by multiple. */
export function classifyAnomalies(quotes: Iterable<Q>, band?: number): { upper: AnomalyRow[]; lower: AnomalyRow[]; surge: AnomalyRow[] } {
  const upper: AnomalyRow[] = [];
  const lower: AnomalyRow[] = [];
  const surge: AnomalyRow[] = [];
  for (const q of quotes) {
    const r = toRow(q);
    if (!r) continue;
    if (band === undefined || r.band === band) {
      if (r.usedPct >= NEAR_BAND) (r.pct > 0 ? upper : lower).push(r);
    }
    if (r.volMultiple > SURGE_MULTIPLE) surge.push(r);
  }
  const byUse = (a: AnomalyRow, b: AnomalyRow) => Number(b.locked) - Number(a.locked) || b.usedPct - a.usedPct || (a.symbol < b.symbol ? -1 : 1);
  upper.sort(byUse);
  lower.sort(byUse);
  surge.sort((a, b) => b.volMultiple - a.volMultiple || (a.symbol < b.symbol ? -1 : 1));
  return { upper, lower, surge };
}

interface AlertLite {
  kind: string;
  symbol: string;
  time: number;
  value: number;
}

/**
 * Adds stocks the engine flagged with a recent live VOLUME_SURGE (last-second volume ≥ 3× its running baseline) to the surge list,
 * so the tab also catches intraday bursts that haven't yet lifted the day's total above 3× the average. Burst rows are marked.
 */
export function withBursts(surge: AnomalyRow[], alerts: AlertLite[], quoteOf: (symbol: string) => Q | undefined, now = Date.now(), windowMs = 10 * 60_000): AnomalyRow[] {
  const have = new Set(surge.map((r) => r.symbol));
  const extra: AnomalyRow[] = [];
  for (const a of alerts) {
    if (a.kind !== 'VOLUME_SURGE' || have.has(a.symbol) || !(a.value >= SURGE_MULTIPLE) || now - a.time > windowMs) continue;
    const q = quoteOf(a.symbol);
    const r = q ? toRow(q) : null;
    if (!r) continue;
    have.add(a.symbol);
    extra.push({ ...r, volMultiple: Math.max(r.volMultiple, a.value), burst: true });
  }
  return [...surge, ...extra].sort((a, b) => b.volMultiple - a.volMultiple || (a.symbol < b.symbol ? -1 : 1));
}
